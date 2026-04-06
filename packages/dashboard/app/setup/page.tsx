"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Cloud,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  AI_DEFAULT_MODELS,
  AI_MODEL_SETTING_KEYS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  normalizeAiProvider,
  type AiModelOption,
  type AiProvider,
} from "@/lib/ai-config";
import { awsRegions, gcpRegions } from "@/lib/cloud-regions";
import {
  formatSetupProgress,
  getNextSetupStep,
  getSetupStepTone,
  type SetupStatusResponse,
} from "@/lib/setup";
import type { ConnectionAuthStrategyStatus } from "@/lib/workflow-studio/types";

const secretSettingKeys = [
  "anthropic_api_key",
  "openai_api_key",
  "aws_secret_access_key",
  "gcp_service_account_key",
] as const;

type SecretSettingKey = (typeof secretSettingKeys)[number];
type CloudProvider = "aws" | "gcp";
type CloudMode = "stored" | "environment" | "later";
type WorkspaceMode = "default" | "custom" | "later";
type StepSaveState = Record<string, boolean>;
type StepErrorState = Record<string, string>;
type StepNoticeState = Record<string, string>;
type ProviderModelSelection = Record<AiProvider, string>;
type ProviderModelOptions = Record<AiProvider, AiModelOption[]>;
type ProviderModelSearch = Record<AiProvider, string>;
type ProviderModelLoading = Record<AiProvider, boolean>;
type ProviderModelErrors = Record<AiProvider, string>;

const defaultStoredSecrets: Record<SecretSettingKey, boolean> = {
  anthropic_api_key: false,
  openai_api_key: false,
  aws_secret_access_key: false,
  gcp_service_account_key: false,
};

const defaultSelectedModels: ProviderModelSelection = {
  claude: "",
  openai: "",
};

const defaultModelOptions: ProviderModelOptions = {
  claude: [],
  openai: [],
};

const defaultModelSearch: ProviderModelSearch = {
  claude: "",
  openai: "",
};

const defaultModelLoading: ProviderModelLoading = {
  claude: false,
  openai: false,
};

const defaultModelErrors: ProviderModelErrors = {
  claude: "",
  openai: "",
};

const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
};

function isSecretSettingKey(key: string): key is SecretSettingKey {
  return (secretSettingKeys as readonly string[]).includes(key);
}

function normalizeCloudProvider(value?: string | null): CloudProvider {
  return value === "gcp" ? "gcp" : "aws";
}

function ensureSelectedModelOption(
  provider: AiProvider,
  selectedModelId: string,
  options: AiModelOption[]
) {
  if (!selectedModelId || options.some((option) => option.id === selectedModelId)) {
    return options;
  }

  return [
    {
      id: selectedModelId,
      displayName: selectedModelId,
      provider,
      createdAt: null,
    },
    ...options,
  ];
}

function FieldLabel({
  children,
  optional,
}: {
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium text-zinc-200">
      <span>{children}</span>
      {optional ? (
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          Optional
        </span>
      ) : null}
    </label>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  stored,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  stored?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <FieldLabel>{label}</FieldLabel>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={stored && !value ? "Stored value on file. Paste a new one to replace it." : placeholder}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
      />
      <p className="text-xs leading-5 text-zinc-500">
        {stored
          ? "Leave this blank to keep the existing secret unchanged."
          : "Secrets are encrypted before GTMShip stores them."}
      </p>
    </div>
  );
}

function StepActions({
  saving,
  saveLabel,
  onSave,
  onSkip,
  notice,
  error,
  skipLabel = "Skip for now",
}: {
  saving: boolean;
  saveLabel: string;
  onSave: () => Promise<void>;
  onSkip: () => Promise<void>;
  notice?: string;
  error?: string;
  skipLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className={`text-sm ${error ? "text-rose-300" : notice ? "text-emerald-300" : "text-zinc-500"}`}>
        {error || notice || "Skips are always reversible from this page or from Settings later."}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void onSkip()}
          disabled={saving}
          className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {skipLabel}
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [storedSecrets, setStoredSecrets] = useState(defaultStoredSecrets);
  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [selectedModels, setSelectedModels] =
    useState<ProviderModelSelection>(defaultSelectedModels);
  const [modelOptions, setModelOptions] =
    useState<ProviderModelOptions>(defaultModelOptions);
  const [modelSearch, setModelSearch] =
    useState<ProviderModelSearch>(defaultModelSearch);
  const [modelLoading, setModelLoading] =
    useState<ProviderModelLoading>(defaultModelLoading);
  const [modelErrors, setModelErrors] =
    useState<ProviderModelErrors>(defaultModelErrors);
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>("aws");
  const [cloudMode, setCloudMode] = useState<CloudMode>("stored");
  const [awsAccessKey, setAwsAccessKey] = useState("");
  const [awsSecretKey, setAwsSecretKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [gcpProjectId, setGcpProjectId] = useState("");
  const [gcpServiceAccountKey, setGcpServiceAccountKey] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-central1");
  const [credentialTestResult, setCredentialTestResult] = useState<{
    valid: boolean;
    identity?: string;
    projectId?: string;
    error?: string;
  } | null>(null);
  const [testingCredentials, setTestingCredentials] = useState(false);
  const [authStrategyMode, setAuthStrategyMode] =
    useState<"proxy" | "secret_manager">("proxy");
  const [authStrategyStatus, setAuthStrategyStatus] =
    useState<ConnectionAuthStrategyStatus | null>(null);
  const [connectionSecretPrefix, setConnectionSecretPrefix] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("default");
  const [projectRoot, setProjectRoot] = useState("");
  const [googleRedirectUri, setGoogleRedirectUri] = useState("");
  const [googleHasCredentials, setGoogleHasCredentials] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [stepSaving, setStepSaving] = useState<StepSaveState>({});
  const [stepErrors, setStepErrors] = useState<StepErrorState>({});
  const [stepNotices, setStepNotices] = useState<StepNoticeState>({});

  const loadSetup = useCallback(async () => {
    setLoading(true);

    try {
      const [setupStatus, settings, strategy, googleOAuth] = await Promise.all([
        api.getSetupStatus(),
        api.getSettings(),
        api.getAuthStrategy().catch(() => null),
        api.getOAuthProvider("google").catch(() => null),
      ]);

      const nextStoredSecrets = { ...defaultStoredSecrets };
      const nextSelectedModels = { ...defaultSelectedModels };
      let nextCloudProvider: CloudProvider | null = null;
      let nextAwsAccessKey = "";
      let nextGcpProjectId = "";
      let nextConnectionSecretPrefix = "";

      for (const setting of settings) {
        if (typeof setting.key === "string" && isSecretSettingKey(setting.key)) {
          nextStoredSecrets[setting.key] = Boolean(setting.value);
          continue;
        }

        if (setting.key === "ai_provider") {
          setAiProvider(normalizeAiProvider(setting.value));
        }
        if (setting.key === "cloud_provider") {
          nextCloudProvider = normalizeCloudProvider(setting.value);
        }
        if (setting.key === AI_MODEL_SETTING_KEYS.claude) {
          nextSelectedModels.claude = setting.value;
        }
        if (setting.key === AI_MODEL_SETTING_KEYS.openai) {
          nextSelectedModels.openai = setting.value;
        }
        if (setting.key === "aws_access_key_id") {
          nextAwsAccessKey = setting.value;
          setAwsAccessKey(setting.value);
        }
        if (setting.key === "aws_region") {
          setAwsRegion(setting.value);
        }
        if (setting.key === "gcp_project_id") {
          nextGcpProjectId = setting.value;
          setGcpProjectId(setting.value);
        }
        if (setting.key === "gcp_region") {
          setGcpRegion(setting.value);
        }
        if (setting.key === "project_root") {
          setProjectRoot(setting.value);
        }
        if (setting.key === "connection_secret_prefix") {
          nextConnectionSecretPrefix = setting.value;
        }
      }

      const cloudChoice = setupStatus.preferences.steps?.cloud?.choice || "";
      const workspaceChoice = setupStatus.preferences.steps?.workspace?.choice || "";

      if (cloudChoice.startsWith("environment:")) {
        setCloudMode("environment");
        setCloudProvider(normalizeCloudProvider(cloudChoice.split(":")[1]));
      } else if (cloudChoice === "later" || setupStatus.preferences.steps?.cloud?.skipped) {
        setCloudMode("later");
        setCloudProvider(
          nextCloudProvider ||
            (nextGcpProjectId || nextStoredSecrets.gcp_service_account_key ? "gcp" : "aws")
        );
      } else {
        setCloudMode("stored");
        setCloudProvider(
          nextCloudProvider ||
            (nextGcpProjectId || nextStoredSecrets.gcp_service_account_key ? "gcp" : nextAwsAccessKey || nextStoredSecrets.aws_secret_access_key ? "aws" : "aws")
        );
      }

      if (workspaceChoice === "later" || setupStatus.preferences.steps?.workspace?.skipped) {
        setWorkspaceMode("later");
      } else if (workspaceChoice === "custom" || projectRoot.trim()) {
        setWorkspaceMode("custom");
      } else {
        setWorkspaceMode("default");
      }

      setStoredSecrets(nextStoredSecrets);
      setSelectedModels(nextSelectedModels);
      setConnectionSecretPrefix(nextConnectionSecretPrefix);
      setStatus(setupStatus);
      if (strategy) {
        setAuthStrategyMode(strategy.mode);
        setAuthStrategyStatus(strategy);
      }
      if (googleOAuth) {
        setGoogleRedirectUri(typeof googleOAuth.redirect_uri === "string" ? googleOAuth.redirect_uri : "");
        setGoogleHasCredentials(Boolean(googleOAuth.has_credentials));
      } else {
        setGoogleRedirectUri("");
        setGoogleHasCredentials(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSetup();
  }, [loadSetup]);

  useEffect(() => {
    const provider = aiProvider;
    const query = modelSearch[provider];
    const typedApiKey =
      provider === "claude" ? anthropicKey.trim() : openaiKey.trim();
    const hasSavedKey =
      provider === "claude"
        ? storedSecrets.anthropic_api_key
        : storedSecrets.openai_api_key;

    if (!typedApiKey && !hasSavedKey) {
      setModelOptions((current) => ({ ...current, [provider]: [] }));
      setModelErrors((current) => ({ ...current, [provider]: "" }));
      setModelLoading((current) => ({ ...current, [provider]: false }));
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setModelLoading((current) => ({ ...current, [provider]: true }));
      setModelErrors((current) => ({ ...current, [provider]: "" }));

      try {
        const response = await api.searchAiModels({
          provider,
          apiKey: typedApiKey || undefined,
          query,
        });

        if (cancelled) {
          return;
        }

        setModelOptions((current) => ({
          ...current,
          [provider]: response.models,
        }));

        if (!query.trim()) {
          setSelectedModels((current) => {
            if (current[provider]) {
              return current;
            }

            const preferredModel =
              response.models.find(
                (model) => model.id === AI_DEFAULT_MODELS[provider]
              ) || response.models[0];

            if (!preferredModel) {
              return current;
            }

            return {
              ...current,
              [provider]: preferredModel.id,
            };
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setModelOptions((current) => ({ ...current, [provider]: [] }));
        setModelErrors((current) => ({
          ...current,
          [provider]:
            error instanceof Error
              ? error.message
              : `Unable to load ${AI_PROVIDER_LABELS[provider]} models.`,
        }));
      } finally {
        if (!cancelled) {
          setModelLoading((current) => ({ ...current, [provider]: false }));
        }
      }
    }, typedApiKey ? 350 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    aiProvider,
    anthropicKey,
    openaiKey,
    modelSearch.claude,
    modelSearch.openai,
    storedSecrets.anthropic_api_key,
    storedSecrets.openai_api_key,
  ]);

  const setStepSavingState = (stepId: string, saving: boolean) => {
    setStepSaving((current) => ({ ...current, [stepId]: saving }));
    if (saving) {
      setStepErrors((current) => ({ ...current, [stepId]: "" }));
      setStepNotices((current) => ({ ...current, [stepId]: "" }));
    }
  };

  const activeProviderHasKey =
    aiProvider === "claude"
      ? Boolean(anthropicKey.trim()) || storedSecrets.anthropic_api_key
      : Boolean(openaiKey.trim()) || storedSecrets.openai_api_key;
  const activeModel = selectedModels[aiProvider];
  const activeModelOptions = ensureSelectedModelOption(
    aiProvider,
    activeModel,
    modelOptions[aiProvider]
  );
  const activeModelLoading = modelLoading[aiProvider];
  const activeModelError = modelErrors[aiProvider];
  const nextStep = status ? getNextSetupStep(status.steps) : null;

  const saveAiStep = async () => {
    setStepSavingState("ai", true);

    try {
      const nextAnthropicKey = anthropicKey.trim();
      const nextOpenAiKey = openaiKey.trim();
      const nextModel = selectedModels[aiProvider].trim();

      if (
        aiProvider === "claude" &&
        !nextAnthropicKey &&
        !storedSecrets.anthropic_api_key
      ) {
        throw new Error("Add an Anthropic API key or skip this step for now.");
      }

      if (
        aiProvider === "openai" &&
        !nextOpenAiKey &&
        !storedSecrets.openai_api_key
      ) {
        throw new Error("Add an OpenAI API key or skip this step for now.");
      }

      const updates: Promise<unknown>[] = [
        api.setSetting("ai_provider", aiProvider),
        api.updateSetupState({
          dismissed: false,
          steps: {
            ai: {
              skipped: false,
              choice: aiProvider,
            },
          },
        }),
      ];

      if (aiProvider === "claude" && nextAnthropicKey) {
        updates.push(api.setSetting("anthropic_api_key", nextAnthropicKey));
      }
      if (aiProvider === "openai" && nextOpenAiKey) {
        updates.push(api.setSetting("openai_api_key", nextOpenAiKey));
      }
      if (nextModel) {
        updates.push(api.setSetting(AI_MODEL_SETTING_KEYS[aiProvider], nextModel));
      }

      await Promise.all(updates);
      setAnthropicKey("");
      setOpenaiKey("");
      setStoredSecrets((current) => ({
        ...current,
        anthropic_api_key:
          current.anthropic_api_key || Boolean(nextAnthropicKey),
        openai_api_key: current.openai_api_key || Boolean(nextOpenAiKey),
      }));
      setStepNotices((current) => ({
        ...current,
        ai: "AI settings saved.",
      }));
      await loadSetup();
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        ai: error instanceof Error ? error.message : "Unable to save AI settings.",
      }));
    } finally {
      setStepSavingState("ai", false);
    }
  };

  const skipStep = async (stepId: "ai" | "cloud" | "secret_storage" | "workspace" | "oauth_apps") => {
    setStepSavingState(stepId, true);

    try {
      const response = await api.updateSetupState({
        dismissed: false,
        steps: {
          [stepId]: {
            skipped: true,
            choice: "later",
          },
        },
      });
      setStatus(response);
      setStepNotices((current) => ({
        ...current,
        [stepId]: "Skipped for now. You can come back anytime.",
      }));
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        [stepId]:
          error instanceof Error ? error.message : "Unable to update setup status.",
      }));
    } finally {
      setStepSavingState(stepId, false);
    }
  };

  const saveCloudStep = async () => {
    setStepSavingState("cloud", true);
    setCredentialTestResult(null);

    try {
      if (cloudMode === "later") {
        const response = await api.updateSetupState({
          dismissed: false,
          steps: {
            cloud: {
              skipped: true,
              choice: "later",
            },
          },
        });
        setStatus(response);
        setStepNotices((current) => ({
          ...current,
          cloud: "Cloud setup skipped for now.",
        }));
        return;
      }

      const updates: Promise<unknown>[] = [
        api.setSetting("cloud_provider", cloudProvider),
      ];

      if (cloudProvider === "aws") {
        updates.push(api.setSetting("aws_region", awsRegion));

        if (cloudMode === "stored") {
          if (!awsAccessKey.trim()) {
            throw new Error("AWS access key ID is required when storing credentials.");
          }
          if (!awsSecretKey.trim() && !storedSecrets.aws_secret_access_key) {
            throw new Error("AWS secret access key is required when storing credentials.");
          }

          updates.push(api.setSetting("aws_access_key_id", awsAccessKey.trim()));
          if (awsSecretKey.trim()) {
            updates.push(api.setSetting("aws_secret_access_key", awsSecretKey.trim()));
          }
        }
      } else {
        updates.push(api.setSetting("gcp_region", gcpRegion));
        if (!gcpProjectId.trim()) {
          throw new Error("GCP project ID is required for Google Cloud setup.");
        }
        updates.push(api.setSetting("gcp_project_id", gcpProjectId.trim()));

        if (cloudMode === "stored") {
          if (!gcpServiceAccountKey.trim() && !storedSecrets.gcp_service_account_key) {
            throw new Error("Service account JSON is required when storing credentials.");
          }
          if (gcpServiceAccountKey.trim()) {
            updates.push(
              api.setSetting("gcp_service_account_key", gcpServiceAccountKey.trim())
            );
          }
        }
      }

      await Promise.all(updates);
      const response = await api.updateSetupState({
        dismissed: false,
        steps: {
          cloud: {
            skipped: false,
            choice: `${cloudMode}:${cloudProvider}`,
          },
        },
      });
      setStatus(response);
      setAwsSecretKey("");
      setGcpServiceAccountKey("");
      setStoredSecrets((current) => ({
        ...current,
        aws_secret_access_key:
          current.aws_secret_access_key || Boolean(awsSecretKey.trim()),
        gcp_service_account_key:
          current.gcp_service_account_key || Boolean(gcpServiceAccountKey.trim()),
      }));
      setStepNotices((current) => ({
        ...current,
        cloud:
          cloudMode === "environment"
            ? "Cloud preference saved for environment/default credentials."
            : "Cloud credentials saved.",
      }));
      await loadSetup();
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        cloud:
          error instanceof Error ? error.message : "Unable to save cloud settings.",
      }));
    } finally {
      setStepSavingState("cloud", false);
    }
  };

  const saveSecretStorageStep = async () => {
    setStepSavingState("secret_storage", true);

    try {
      const updates: Promise<unknown>[] = [];
      if (connectionSecretPrefix.trim()) {
        updates.push(
          api.setSetting("connection_secret_prefix", connectionSecretPrefix.trim())
        );
      }

      await Promise.all(updates);
      const strategy = await api.setAuthStrategy({ mode: authStrategyMode });
      const response = await api.updateSetupState({
        dismissed: false,
        steps: {
          secret_storage: {
            skipped: false,
            choice: authStrategyMode,
          },
        },
      });
      setAuthStrategyStatus(strategy);
      setStatus(response);
      setStepNotices((current) => ({
        ...current,
        secret_storage: "Secret storage preference saved.",
      }));
      await loadSetup();
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        secret_storage:
          error instanceof Error
            ? error.message
            : "Unable to update secret storage.",
      }));
    } finally {
      setStepSavingState("secret_storage", false);
    }
  };

  const saveWorkspaceStep = async () => {
    setStepSavingState("workspace", true);

    try {
      if (workspaceMode === "custom") {
        if (!projectRoot.trim()) {
          throw new Error("Enter a project root to use a custom workspace.");
        }
        await api.setSetting("project_root", projectRoot.trim());
      } else if (workspaceMode === "default") {
        await api.deleteSetting("project_root").catch(() => null);
      }

      const response = await api.updateSetupState({
        dismissed: false,
        steps: {
          workspace: {
            skipped: workspaceMode === "later",
            choice: workspaceMode,
          },
        },
      });
      setStatus(response);
      setStepNotices((current) => ({
        ...current,
        workspace:
          workspaceMode === "custom"
            ? "Custom workspace saved."
            : workspaceMode === "default"
              ? "Default workspace restored."
              : "Workspace step skipped for now.",
      }));
      await loadSetup();
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        workspace:
          error instanceof Error ? error.message : "Unable to save workspace settings.",
      }));
    } finally {
      setStepSavingState("workspace", false);
    }
  };

  const saveOAuthAppsStep = async () => {
    setStepSavingState("oauth_apps", true);

    try {
      if (!googleHasCredentials && (!googleClientId.trim() || !googleClientSecret.trim())) {
        throw new Error("Enter both Google OAuth values or skip this step for now.");
      }

      if (googleClientId.trim() || googleClientSecret.trim()) {
        await api.upsertOAuthProvider("google", {
          client_id: googleClientId.trim(),
          client_secret: googleClientSecret.trim(),
        });
      }

      const response = await api.updateSetupState({
        dismissed: false,
        steps: {
          oauth_apps: {
            skipped: false,
            choice: "google",
          },
        },
      });
      setGoogleClientId("");
      setGoogleClientSecret("");
      setGoogleHasCredentials(true);
      setStatus(response);
      setStepNotices((current) => ({
        ...current,
        oauth_apps: "Shared Google OAuth credentials saved.",
      }));
      await loadSetup();
    } catch (error) {
      setStepErrors((current) => ({
        ...current,
        oauth_apps:
          error instanceof Error
            ? error.message
            : "Unable to save shared OAuth credentials.",
      }));
    } finally {
      setStepSavingState("oauth_apps", false);
    }
  };

  const testCloudCredentials = async () => {
    setTestingCredentials(true);
    setCredentialTestResult(null);

    try {
      const result = await api.validateCloudAuth(cloudProvider);
      setCredentialTestResult(result);
    } catch {
      setCredentialTestResult({
        valid: false,
        error: "Failed to reach auth service for credential validation.",
      });
    } finally {
      setTestingCredentials(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 size={16} className="animate-spin" />
          Loading setup checklist...
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="space-y-6">
        <section className="overflow-hidden rounded-[28px] border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-950 p-6 sm:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-400">
                <ShieldCheck size={12} />
                Optional onboarding
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Setup checklist
              </h1>
              <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                Configure the core details GTMShip needs for AI, deployments, and
                shared secrets. Every step is skippable, and the rest of the app
                stays available while you fill this in.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                <span>{status ? formatSetupProgress(status.progress) : "0/5 steps ready"}</span>
                {nextStep ? <span>Next: {nextStep.title}</span> : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/connections"
                className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
              >
                Back to app
              </Link>
              {status?.dismissed ? (
                <button
                  type="button"
                  onClick={async () => {
                    const response = await api.updateSetupState({ dismissed: false });
                    setStatus(response);
                  }}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  Re-enable reminders
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {status ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {status.steps.map((step) => (
              <div
                key={step.id}
                className={`rounded-2xl border px-4 py-3 text-sm ${getSetupStepTone(step.status)}`}
              >
                <p className="font-medium text-white">{step.title}</p>
                <p className="mt-2 text-xs leading-5">{step.summary}</p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid gap-6">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <Bot size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">AI provider</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Pick the default provider GTMShip should use and save a working API key.
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {AI_PROVIDERS.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => setAiProvider(provider)}
                  className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                    aiProvider === provider
                      ? "border-blue-500 bg-blue-500/10 text-white"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-white"
                  }`}
                >
                  {AI_PROVIDER_LABELS[provider]}
                </button>
              ))}
            </div>

            <div className="mt-6 grid gap-4 xl:grid-cols-2">
              {aiProvider === "claude" ? (
                <SecretField
                  label="Anthropic API key"
                  value={anthropicKey}
                  onChange={setAnthropicKey}
                  placeholder="sk-ant-..."
                  stored={storedSecrets.anthropic_api_key}
                />
              ) : (
                <SecretField
                  label="OpenAI API key"
                  value={openaiKey}
                  onChange={setOpenaiKey}
                  placeholder="sk-..."
                  stored={storedSecrets.openai_api_key}
                />
              )}

              <div className="space-y-2.5">
                <FieldLabel>Live model search</FieldLabel>
                <input
                  value={modelSearch[aiProvider]}
                  onChange={(event) =>
                    setModelSearch((current) => ({
                      ...current,
                      [aiProvider]: event.target.value,
                    }))
                  }
                  placeholder={
                    aiProvider === "claude"
                      ? "Search sonnet, opus, haiku..."
                      : "Search gpt-5, gpt-4.1, o4-mini..."
                  }
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                />

                <select
                  value={activeModel}
                  onChange={(event) =>
                    setSelectedModels((current) => ({
                      ...current,
                      [aiProvider]: event.target.value,
                    }))
                  }
                  disabled={!activeProviderHasKey || activeModelLoading}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">
                    {!activeProviderHasKey
                      ? `Add a ${AI_PROVIDER_LABELS[aiProvider]} key to load models`
                      : activeModelLoading
                        ? "Loading live models..."
                        : "Use provider default or pick a model"}
                  </option>
                  {activeModelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName === model.id
                        ? model.id
                        : `${model.displayName} (${model.id})`}
                    </option>
                  ))}
                </select>

                <p className={`text-xs leading-5 ${activeModelError ? "text-rose-300" : "text-zinc-500"}`}>
                  {activeModelError ||
                    (activeProviderHasKey
                      ? "GTMShip can fall back to the provider default model if you leave the dropdown empty."
                      : "Enter an API key to look up live models.")}
                </p>
              </div>
            </div>

            <div className="mt-6">
              <StepActions
                saving={Boolean(stepSaving.ai)}
                saveLabel="Save AI setup"
                onSave={saveAiStep}
                onSkip={() => skipStep("ai")}
                notice={stepNotices.ai}
                error={stepErrors.ai}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <Cloud size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Cloud deploy target</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Choose your primary cloud and tell GTMShip whether to store credentials or use environment defaults.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {(["aws", "gcp"] as const).map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => setCloudProvider(provider)}
                      className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                        cloudProvider === provider
                          ? "border-blue-500 bg-blue-500/10 text-white"
                          : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-white"
                      }`}
                    >
                      {CLOUD_PROVIDER_LABELS[provider]}
                    </button>
                  ))}
                </div>

                <div className="grid gap-3">
                  {[
                    {
                      value: "stored" as const,
                      title: "Store in GTMShip",
                      body: "Save cloud credentials in encrypted settings and let GTMShip validate them from the dashboard.",
                    },
                    {
                      value: "environment" as const,
                      title: "Use environment defaults",
                      body: "Keep credentials outside GTMShip and let deploys rely on environment or default provider credentials.",
                    },
                    {
                      value: "later" as const,
                      title: "Later",
                      body: "Skip cloud configuration for now and come back before you deploy.",
                    },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setCloudMode(option.value)}
                      className={`rounded-2xl border px-4 py-4 text-left transition-colors ${
                        cloudMode === option.value
                          ? "border-blue-500 bg-blue-500/10 text-white"
                          : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                      }`}
                    >
                      <p className="text-sm font-medium">{option.title}</p>
                      <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {option.body}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
                {cloudProvider === "aws" ? (
                  <>
                    <div className="space-y-2.5">
                      <FieldLabel>Region</FieldLabel>
                      <select
                        value={awsRegion}
                        onChange={(event) => setAwsRegion(event.target.value)}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                      >
                        {awsRegions.map((region) => (
                          <option key={region.value} value={region.value}>
                            {region.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {cloudMode === "stored" ? (
                      <>
                        <div className="space-y-2.5">
                          <FieldLabel>Access Key ID</FieldLabel>
                          <input
                            value={awsAccessKey}
                            onChange={(event) => setAwsAccessKey(event.target.value)}
                            placeholder="AKIA..."
                            className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                          />
                        </div>
                        <SecretField
                          label="Secret Access Key"
                          value={awsSecretKey}
                          onChange={setAwsSecretKey}
                          placeholder="Paste the secret access key"
                          stored={storedSecrets.aws_secret_access_key}
                        />
                      </>
                    ) : (
                      <p className="text-sm leading-6 text-zinc-500">
                        GTMShip will keep the AWS region preference, but it will not store an access-key pair in the app.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="space-y-2.5">
                      <FieldLabel>GCP Project ID</FieldLabel>
                      <input
                        value={gcpProjectId}
                        onChange={(event) => setGcpProjectId(event.target.value)}
                        placeholder="my-gcp-project"
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-2.5">
                      <FieldLabel>Region</FieldLabel>
                      <select
                        value={gcpRegion}
                        onChange={(event) => setGcpRegion(event.target.value)}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                      >
                        {gcpRegions.map((region) => (
                          <option key={region.value} value={region.value}>
                            {region.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {cloudMode === "stored" ? (
                      <div className="space-y-2.5">
                        <FieldLabel>Service account JSON</FieldLabel>
                        <textarea
                          value={gcpServiceAccountKey}
                          onChange={(event) => setGcpServiceAccountKey(event.target.value)}
                          rows={7}
                          spellCheck={false}
                          placeholder={
                            storedSecrets.gcp_service_account_key && !gcpServiceAccountKey
                              ? "Stored JSON key on file. Paste a new one to replace it."
                              : '{"type":"service_account","project_id":"..."}'
                          }
                          className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 font-mono text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                        />
                      </div>
                    ) : (
                      <p className="text-sm leading-6 text-zinc-500">
                        GTMShip will keep the GCP project and region preferences, but it will not store the service account JSON here.
                      </p>
                    )}
                  </>
                )}

                {cloudMode === "stored" ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">
                        Validate stored credentials
                      </p>
                      <button
                        type="button"
                        onClick={() => void testCloudCredentials()}
                        disabled={testingCredentials}
                        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {testingCredentials ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <ShieldCheck size={14} />
                        )}
                        Test
                      </button>
                    </div>
                    {credentialTestResult ? (
                      <div
                        className={`mt-3 rounded-xl border px-3 py-3 text-sm ${
                          credentialTestResult.valid
                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                            : "border-rose-500/20 bg-rose-500/10 text-rose-200"
                        }`}
                      >
                        {credentialTestResult.valid ? (
                          <p>
                            {credentialTestResult.identity || "Credentials validated successfully."}
                          </p>
                        ) : (
                          <p>{credentialTestResult.error || "Credential validation failed."}</p>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-6">
              <StepActions
                saving={Boolean(stepSaving.cloud)}
                saveLabel="Save cloud setup"
                onSave={saveCloudStep}
                onSkip={() => skipStep("cloud")}
                notice={stepNotices.cloud}
                error={stepErrors.cloud}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <ShieldCheck size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Secret storage</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Local preview and run flows stay on GTMShip's local encrypted storage. Cloud deployments use provider-matched secret managers once backend sync is configured.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                {
                  value: "proxy" as const,
                  title: "Proxy mode",
                  body: "Connections stay in local encrypted storage for previews, local runs, and local deployments.",
                },
                {
                  value: "secret_manager" as const,
                  title: "Secret manager",
                  body: "Connections still write locally first, then sync to AWS or GCP secret backends for cloud runtime access.",
                },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAuthStrategyMode(option.value)}
                  className={`rounded-2xl border px-5 py-4 text-left transition-colors ${
                    authStrategyMode === option.value
                      ? "border-blue-500 bg-blue-500/10 text-white"
                      : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                  }`}
                >
                  <p className="text-sm font-medium">{option.title}</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-500">{option.body}</p>
                </button>
              ))}
            </div>

            <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <div className="space-y-2.5">
                <FieldLabel optional>Secret prefix override</FieldLabel>
                <input
                  value={connectionSecretPrefix}
                  onChange={(event) => setConnectionSecretPrefix(event.target.value)}
                  placeholder="gtmship-connections"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                />
                <p className="text-xs leading-5 text-zinc-500">
                  Leave this empty to keep the default secret prefix.
                </p>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                <p className="text-sm font-medium text-white">Current auth health</p>
                <p className="mt-2 text-sm text-zinc-400">
                  Mode: {authStrategyStatus?.mode || "proxy"} • Status: {authStrategyStatus?.status || "unknown"}
                </p>
                <p className="mt-2 text-sm text-zinc-500">
                  Backends configured: {authStrategyStatus?.configuredBackends.length || 0}
                </p>
              </div>
            </div>

            <div className="mt-6">
              <StepActions
                saving={Boolean(stepSaving.secret_storage)}
                saveLabel="Save secret storage"
                onSave={saveSecretStorageStep}
                onSkip={() => skipStep("secret_storage")}
                notice={stepNotices.secret_storage}
                error={stepErrors.secret_storage}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <FolderOpen size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Workspace</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Point Workflow Studio at the default local workspace or save a custom project root.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                {
                  value: "default" as const,
                  title: "Default workspace",
                  body: "~/.gtmship/projects/default",
                },
                {
                  value: "custom" as const,
                  title: "Custom path",
                  body: "Use a project folder outside the default workspace.",
                },
                {
                  value: "later" as const,
                  title: "Later",
                  body: "Keep this open until you know where your workflows will live.",
                },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setWorkspaceMode(option.value)}
                  className={`rounded-2xl border px-4 py-4 text-left transition-colors ${
                    workspaceMode === option.value
                      ? "border-blue-500 bg-blue-500/10 text-white"
                      : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                  }`}
                >
                  <p className="text-sm font-medium">{option.title}</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-500">{option.body}</p>
                </button>
              ))}
            </div>

            {workspaceMode === "custom" ? (
              <div className="mt-6 space-y-2.5">
                <FieldLabel>Project root</FieldLabel>
                <input
                  value={projectRoot}
                  onChange={(event) => setProjectRoot(event.target.value)}
                  placeholder="/absolute/path/to/your/gtmship-project"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                />
              </div>
            ) : null}

            <div className="mt-6">
              <StepActions
                saving={Boolean(stepSaving.workspace)}
                saveLabel="Save workspace"
                onSave={saveWorkspaceStep}
                onSkip={() => skipStep("workspace")}
                notice={stepNotices.workspace}
                error={stepErrors.workspace}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <KeyRound size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Shared OAuth apps</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Optional: save shared Google OAuth credentials once, then reuse them for Gmail and Google Sheets connections.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2.5">
                <FieldLabel>Google OAuth client ID</FieldLabel>
                <input
                  value={googleClientId}
                  onChange={(event) => setGoogleClientId(event.target.value)}
                  placeholder="apps.googleusercontent.com"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                />
              </div>
              <SecretField
                label="Google OAuth client secret"
                value={googleClientSecret}
                onChange={setGoogleClientSecret}
                placeholder="GOCSPX-..."
                stored={googleHasCredentials}
              />
            </div>

            <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-white">Redirect URI</p>
                  <p className="mt-1 break-all text-zinc-400">
                    {googleRedirectUri || "Load auth-service to see the generated redirect URI."}
                  </p>
                </div>
                <a
                  href="https://docs.cloud.google.com/iam/docs/service-accounts-create"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                >
                  Google docs
                  <ExternalLink size={14} />
                </a>
              </div>
            </div>

            <div className="mt-6">
              <StepActions
                saving={Boolean(stepSaving.oauth_apps)}
                saveLabel="Save shared OAuth"
                onSave={saveOAuthAppsStep}
                onSkip={() => skipStep("oauth_apps")}
                notice={stepNotices.oauth_apps}
                error={stepErrors.oauth_apps}
              />
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-sm text-zinc-500">
          <p>
            Current advanced configuration still lives in{" "}
            <Link href="/settings" className="text-zinc-300 underline-offset-4 hover:underline">
              Settings
            </Link>
            . This setup flow is additive, and it does not change the existing dashboard routes or CLI commands.
          </p>
        </section>
      </div>
    </div>
  );
}
