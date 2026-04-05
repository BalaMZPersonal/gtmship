"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type MemoryRecord } from "@/lib/api";
import type { ConnectionAuthStrategyStatus } from "@/lib/workflow-studio/types";
import {
  AI_DEFAULT_MODELS,
  AI_MODEL_SETTING_KEYS,
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  normalizeAiProvider,
  type AiModelOption,
  type AiProvider,
} from "@/lib/ai-config";
import {
  AlertCircle,
  Bot,
  Brain,
  CheckCircle,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
  Search,
} from "lucide-react";
import { awsRegions, gcpRegions } from "@/lib/cloud-regions";

const secretSettingKeys = [
  "anthropic_api_key",
  "openai_api_key",
  "aws_secret_access_key",
  "gcp_service_account_key",
] as const;

type SecretSettingKey = (typeof secretSettingKeys)[number];
const cloudProviders = ["aws", "gcp"] as const;

type StoredSecrets = Record<SecretSettingKey, boolean>;
type CloudProvider = (typeof cloudProviders)[number];
type GuideStep = { title: string; body: string };
type GuideLink = { href: string; label: string };
type GuidePermission = { name: string; detail: string };
type GuidePermissionGroup = {
  label: string;
  tone?: "required" | "optional";
  items: GuidePermission[];
  footnote?: string;
};
type ProviderModelSelection = Record<AiProvider, string>;
type ProviderModelOptions = Record<AiProvider, AiModelOption[]>;
type ProviderModelSearch = Record<AiProvider, string>;
type ProviderModelLoading = Record<AiProvider, boolean>;
type ProviderModelErrors = Record<AiProvider, string>;

const defaultStoredSecrets: StoredSecrets = {
  anthropic_api_key: false,
  openai_api_key: false,
  aws_secret_access_key: false,
  gcp_service_account_key: false,
};

const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
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


const awsSetupSteps: GuideStep[] = [
  {
    title: "Create or choose a dedicated IAM user",
    body: "AWS does not expose a first-class service account object. For an external app using long-lived keys, a dedicated IAM user is the closest equivalent.",
  },
  {
    title: "Open Security credentials and create an access key",
    body: "Go to IAM -> Users -> your user -> Security credentials -> Access keys -> Create access key, then choose the CLI use case and complete the wizard.",
  },
  {
    title: "Download the key once and keep permissions tight",
    body: "Copy the Access Key ID and Secret Access Key immediately, because AWS only shows the secret once. Attach least-privilege permissions for the resources GTMShip needs.",
  },
];

const awsLinks: GuideLink[] = [
  {
    label: "Manage access keys",
    href: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },
  {
    label: "AWS managed policies",
    href: "https://docs.aws.amazon.com/aws-managed-policy/latest/reference/about-managed-policy-reference.html",
  },
  {
    label: "IAM best practices",
    href: "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html",
  },
];

const awsPermissionGroups: GuidePermissionGroup[] = [
  {
    label: "Quick setup for the current codebase",
    tone: "required",
    items: [
      {
        name: "AmazonVPCFullAccess",
        detail:
          "Covers the VPC, subnets, NAT, route tables, internet gateway, and security groups that GTMShip creates during AWS deploys.",
      },
      {
        name: "AmazonRDSFullAccess",
        detail:
          "Creates and manages the PostgreSQL RDS instance and subnet group used by the current deployer.",
      },
      {
        name: "AmazonS3FullAccess",
        detail:
          "Creates and manages the workflow-artifact bucket and its bucket-level settings.",
      },
      {
        name: "AWSLambda_FullAccess",
        detail:
          "Creates the Lambda runtime function, updates code, and configures invoke permissions.",
      },
      {
        name: "AmazonAPIGatewayAdministrator",
        detail:
          "Creates and updates the API Gateway HTTP API that fronts webhook traffic.",
      },
      {
        name: "IAMFullAccess",
        detail:
          "Creates the Lambda execution role, attaches managed policies, writes inline policies, and passes the role to Lambda.",
      },
    ],
    footnote:
      "The current AWS deployer does not yet ship a customer-managed least-privilege IAM policy template, so these AWS-managed policies are the cleanest way to match what the code provisions today.",
  },
  {
    label: "Add if you want GTMShip log reads with the same credentials",
    tone: "optional",
    items: [
      {
        name: "CloudWatchLogsReadOnlyAccess",
        detail:
          "Lets the current logs command read CloudWatch Logs for deployed workflows.",
      },
    ],
  },
];

const gcpSetupSteps: GuideStep[] = [
  {
    title: "Create a service account",
    body: "Open Google Cloud Console -> IAM & Admin -> Service Accounts, then click Create service account and finish the name and description step.",
  },
  {
    title: "Grant only the roles GTMShip needs",
    body: "During Create and continue, or later in IAM -> Grant access, assign the service account the smallest set of roles required for your deployment.",
  },
  {
    title: "Create and download a JSON key",
    body: "Open the service account -> Keys -> Add key -> Create new key -> JSON. Google downloads the file immediately, and you should store it outside your repo.",
  },
];

const gcpLinks: GuideLink[] = [
  {
    label: "Create service accounts",
    href: "https://docs.cloud.google.com/iam/docs/service-accounts-create",
  },
  {
    label: "Service account permissions",
    href: "https://docs.cloud.google.com/iam/docs/service-account-permissions",
  },
  {
    label: "Create JSON keys",
    href: "https://docs.cloud.google.com/iam/docs/keys-create-delete",
  },
];

const gcpPermissionGroups: GuidePermissionGroup[] = [
  {
    label: "Required for the current GCP deploy path",
    tone: "required",
    items: [
      {
        name: "roles/run.admin",
        detail:
          "Creates and updates the Cloud Run service GTMShip deploys today.",
      },
      {
        name: "roles/compute.networkAdmin",
        detail:
          "Creates the VPC, subnet, router, NAT, private range, and firewall-adjacent networking resources used by the deployer.",
      },
      {
        name: "roles/servicenetworking.networksAdmin",
        detail:
          "Creates the private service networking connection required for Cloud SQL private IP.",
      },
      {
        name: "roles/vpcaccess.admin",
        detail:
          "Creates the Serverless VPC Access connector used by the Cloud Run service.",
      },
      {
        name: "roles/cloudsql.admin",
        detail:
          "Creates and manages the PostgreSQL Cloud SQL instance, database, and user.",
      },
      {
        name: "roles/storage.admin",
        detail:
          "Creates and manages the Cloud Storage bucket used for workflow artifacts.",
      },
      {
        name: "roles/iam.serviceAccountAdmin",
        detail:
          "Creates the runtime service account that the Cloud Run service runs as.",
      },
      {
        name: "roles/iam.serviceAccountUser",
        detail:
          "Lets the deployer attach the runtime service account to the Cloud Run service.",
      },
      {
        name: "roles/resourcemanager.projectIamAdmin",
        detail:
          "Writes the project-level IAM bindings that GTMShip adds to the runtime service account.",
      },
    ],
  },
  {
    label: "Add when you use GCP Secret Manager auth storage",
    tone: "optional",
    items: [
      {
        name: "roles/secretmanager.admin",
        detail:
          "Lets auth-service write synced connection credentials into GCP Secret Manager.",
      },
    ],
  },
  {
    label: "Add if you want GTMShip log reads with the same credentials",
    tone: "optional",
    items: [
      {
        name: "roles/logging.viewer",
        detail:
          "Lets the current logs flow read Cloud Logging entries for deployed workflows.",
      },
    ],
  },
];

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
    <label className="block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
      {children}
      {optional ? <span className="ml-1 text-zinc-600 normal-case tracking-normal">(optional)</span> : null}
    </label>
  );
}

function SecretInput({
  label,
  id,
  value,
  onChange,
  placeholder,
  stored,
  showValue,
  onToggle,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  stored: boolean;
  showValue: boolean;
  onToggle: () => void;
}) {
  const helper = value
    ? "This new value will replace the stored secret when you save."
    : stored
      ? "A secret is already stored. Leave this blank to keep it unchanged."
      : "Paste a secret here to store it in GTMShip.";

  return (
    <div className="space-y-2.5">
      <FieldLabel>{label}</FieldLabel>
      <div className="relative">
        <input
          type={showValue ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={stored && !value ? "Stored secret on file. Enter a new one to replace it." : placeholder}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 pr-11 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={showValue ? `Hide ${id}` : `Show ${id}`}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-white"
        >
          {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-xs leading-5 text-zinc-500">{helper}</p>
    </div>
  );
}

function SetupGuide({
  badge,
  title,
  description,
  consolePath,
  note,
  permissions,
  steps,
  links,
  children,
}: {
  badge: string;
  title: string;
  description: string;
  consolePath: string;
  note: string;
  permissions: GuidePermissionGroup[];
  steps: GuideStep[];
  links: GuideLink[];
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/75 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-blue-300">
          {badge}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Console path</p>
          <p className="mt-2 text-sm leading-6 text-zinc-300">{consolePath}</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="text-sm leading-6 text-zinc-300">{note}</p>
        </div>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
              Permissions Required
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              These are limited to the services the current codebase provisions or
              reads today.
            </p>
          </div>

          <div className="space-y-4">
            {permissions.map((group) => (
              <div key={group.label} className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${
                      group.tone === "required"
                        ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border border-amber-500/30 bg-amber-500/10 text-amber-300"
                    }`}
                  >
                    {group.tone === "required" ? "Required" : "Conditional"}
                  </span>
                  <p className="text-sm font-medium text-zinc-200">{group.label}</p>
                </div>

                <div className="mt-3 space-y-3">
                  {group.items.map((item) => (
                    <div key={item.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                      <p className="font-mono text-xs text-blue-200">{item.name}</p>
                      <p className="mt-1 text-sm leading-6 text-zinc-400">{item.detail}</p>
                    </div>
                  ))}
                </div>

                {group.footnote ? (
                  <p className="mt-3 text-xs leading-5 text-zinc-500">{group.footnote}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-xs font-medium text-zinc-300">
                {index + 1}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-200">{step.title}</p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
          {children}
        </div>

        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
            >
              {link.label}
              <ExternalLink size={12} />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>("aws");
  const [authStrategyMode, setAuthStrategyMode] =
    useState<"proxy" | "secret_manager">("proxy");
  const [authStrategyStatus, setAuthStrategyStatus] =
    useState<ConnectionAuthStrategyStatus | null>(null);
  const [authStrategyBackfill, setAuthStrategyBackfill] = useState<{
    connections?: {
      activeConnections: number;
      syncedReplicas: number;
      errorReplicas: number;
    };
    deployments?: {
      total: number;
      updated: number;
      skipped: number;
    };
  } | null>(null);
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
  const [awsAccessKey, setAwsAccessKey] = useState("");
  const [awsSecretKey, setAwsSecretKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [gcpProjectId, setGcpProjectId] = useState("");
  const [gcpServiceAccountKey, setGcpServiceAccountKey] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-central1");
  const [projectRoot, setProjectRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [storedSecrets, setStoredSecrets] = useState<StoredSecrets>(defaultStoredSecrets);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testingCredentials, setTestingCredentials] = useState(false);
  const [credentialTestResult, setCredentialTestResult] = useState<{
    valid: boolean;
    identity?: string;
    error?: string;
  } | null>(null);

  // Memory state
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(true);
  const [memoryFilter, setMemoryFilter] = useState({ scope: "", category: "", q: "" });
  const [deletingMemoryIds, setDeletingMemoryIds] = useState<Set<string>>(new Set());

  const loadMemories = useCallback(async () => {
    setMemoriesLoading(true);
    try {
      const params: Record<string, string> = {};
      if (memoryFilter.scope) params.scope = memoryFilter.scope;
      if (memoryFilter.category) params.category = memoryFilter.category;
      if (memoryFilter.q) params.q = memoryFilter.q;
      const data = await api.getMemories(params);
      setMemories(Array.isArray(data) ? data : []);
    } catch {
      setMemories([]);
    } finally {
      setMemoriesLoading(false);
    }
  }, [memoryFilter]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  useEffect(() => {
    (async () => {
      try {
        const [settings, strategy] = await Promise.all([
          api.getSettings(),
          api.getAuthStrategy().catch(() => null),
        ]);
        const nextStoredSecrets = { ...defaultStoredSecrets };
        const nextSelectedModels = { ...defaultSelectedModels };
        let nextCloudProvider: CloudProvider | null = null;
        let nextAwsAccessKey = "";
        let nextGcpProjectId = "";

        for (const setting of settings) {
          if (typeof setting.key === "string" && isSecretSettingKey(setting.key)) {
            const secretKey = setting.key;
            nextStoredSecrets[secretKey] = Boolean(setting.value);
            continue;
          }

          if (setting.key === "ai_provider") setAiProvider(normalizeAiProvider(setting.value));
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
          if (setting.key === "aws_region") setAwsRegion(setting.value);
          if (setting.key === "gcp_project_id") {
            nextGcpProjectId = setting.value;
            setGcpProjectId(setting.value);
          }
          if (setting.key === "gcp_region") setGcpRegion(setting.value);
          if (setting.key === "project_root") setProjectRoot(setting.value);
        }

        setStoredSecrets(nextStoredSecrets);
        setSelectedModels(nextSelectedModels);
        setCloudProvider(
          nextCloudProvider ||
            (nextGcpProjectId || nextStoredSecrets.gcp_service_account_key
              ? "gcp"
              : nextAwsAccessKey || nextStoredSecrets.aws_secret_access_key
                ? "aws"
                : "aws")
        );
        if (strategy) {
          setAuthStrategyMode(strategy.mode);
          setAuthStrategyStatus(strategy);
        }
      } catch {
        // auth-service may not be running
      }
    })();
  }, []);

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

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    setCredentialTestResult(null);
    setAuthStrategyBackfill(null);

    const nextAnthropicKey = anthropicKey.trim();
    const nextOpenAiKey = openaiKey.trim();
    const nextAnthropicModel = selectedModels.claude.trim();
    const nextOpenAiModel = selectedModels.openai.trim();
    const nextAwsAccessKey = awsAccessKey.trim();
    const nextAwsSecretKey = awsSecretKey.trim();
    const nextGcpProjectId = gcpProjectId.trim();
    const nextGcpServiceAccountKey = gcpServiceAccountKey.trim();
    const nextProjectRoot = projectRoot.trim();

    try {
      const updates: Promise<unknown>[] = [
        api.setSetting("ai_provider", aiProvider),
        api.setSetting("cloud_provider", cloudProvider),
        api.setSetting("aws_region", awsRegion),
        api.setSetting("gcp_region", gcpRegion),
      ];

      if (nextAnthropicKey) updates.push(api.setSetting("anthropic_api_key", nextAnthropicKey));
      if (nextOpenAiKey) updates.push(api.setSetting("openai_api_key", nextOpenAiKey));
      if (nextAnthropicModel) {
        updates.push(api.setSetting(AI_MODEL_SETTING_KEYS.claude, nextAnthropicModel));
      }
      if (nextOpenAiModel) {
        updates.push(api.setSetting(AI_MODEL_SETTING_KEYS.openai, nextOpenAiModel));
      }
      if (nextAwsAccessKey) updates.push(api.setSetting("aws_access_key_id", nextAwsAccessKey));
      if (nextAwsSecretKey) updates.push(api.setSetting("aws_secret_access_key", nextAwsSecretKey));
      if (nextGcpProjectId) updates.push(api.setSetting("gcp_project_id", nextGcpProjectId));
      if (nextGcpServiceAccountKey) {
        updates.push(api.setSetting("gcp_service_account_key", nextGcpServiceAccountKey));
      }
      if (nextProjectRoot) updates.push(api.setSetting("project_root", nextProjectRoot));

      await Promise.all(updates);
      const nextAuthStrategy = await api.setAuthStrategy({
        mode: authStrategyMode,
      });

      setStoredSecrets((current) => ({
        anthropic_api_key: current.anthropic_api_key || Boolean(nextAnthropicKey),
        openai_api_key: current.openai_api_key || Boolean(nextOpenAiKey),
        aws_secret_access_key: current.aws_secret_access_key || Boolean(nextAwsSecretKey),
        gcp_service_account_key:
          current.gcp_service_account_key || Boolean(nextGcpServiceAccountKey),
      }));

      setAnthropicKey("");
      setOpenaiKey("");
      setAwsSecretKey("");
      setGcpServiceAccountKey("");
      setAuthStrategyStatus(nextAuthStrategy);
      setAuthStrategyBackfill(nextAuthStrategy.backfill || null);

      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string) => {
    setShowKeys((current) => ({ ...current, [key]: !current[key] }));
  };

  const testCloudCredentials = async () => {
    setTestingCredentials(true);
    setCredentialTestResult(null);
    try {
      const result = await api.validateCloudAuth(cloudProvider);
      setCredentialTestResult(result);
    } catch {
      setCredentialTestResult({ valid: false, error: "Failed to reach auth service." });
    } finally {
      setTestingCredentials(false);
    }
  };

  const activeProviderHasKey =
    aiProvider === "claude"
      ? Boolean(anthropicKey.trim()) || storedSecrets.anthropic_api_key
      : Boolean(openaiKey.trim()) || storedSecrets.openai_api_key;
  const activeModelOptions = ensureSelectedModelOption(
    aiProvider,
    selectedModels[aiProvider],
    modelOptions[aiProvider]
  );
  const activeModelError = modelErrors[aiProvider];
  const activeModelLoading = modelLoading[aiProvider];
  const activeModelSearch = modelSearch[aiProvider];
  const activeModel = selectedModels[aiProvider];
  const activeProviderKeyInput = aiProvider === "claude" ? anthropicKey : openaiKey;
  const alternateCloudProvider: CloudProvider = cloudProvider === "aws" ? "gcp" : "aws";
  const authStrategyHealthTone =
    authStrategyStatus?.status === "healthy"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : authStrategyStatus?.status === "migrating"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
        : "border-red-500/30 bg-red-500/10 text-red-300";
  const configuredBackends = authStrategyStatus?.configuredBackends || [];

  const renderCloudSetupGuide = (provider: CloudProvider) => {
    if (provider === "aws") {
      return (
            <SetupGuide
              badge="AWS"
              title="IAM user credentials for external deployments"
              description="GTMShip stores an AWS Access Key ID, Secret Access Key, and region. For the current codebase, the deployer provisions VPC, RDS, S3, Lambda, IAM, and API Gateway resources in your AWS account."
              consolePath="IAM -> Users -> choose the machine user -> Security credentials -> Access keys -> Create access key"
              note="AWS recommends short-lived credentials and IAM roles when the app runs inside AWS. GTMShip currently accepts an access-key pair here, so use a dedicated machine user and keep the policy set scoped to the services below."
              permissions={awsPermissionGroups}
              steps={awsSetupSteps}
              links={awsLinks}
            >
          <div className="grid gap-4">
            <div className="space-y-2.5">
              <FieldLabel>Access Key ID</FieldLabel>
              <input
                value={awsAccessKey}
                onChange={(event) => setAwsAccessKey(event.target.value)}
                placeholder="AKIA..."
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
              />
              <p className="text-xs leading-5 text-zinc-500">
                This is the public identifier from the AWS access key pair.
              </p>
            </div>

            <SecretInput
              label="Secret Access Key"
              id="aws_secret_access_key"
              value={awsSecretKey}
              onChange={setAwsSecretKey}
              placeholder="Paste the secret access key from the download step"
              stored={storedSecrets.aws_secret_access_key}
              showValue={Boolean(showKeys.aws_secret_access_key)}
              onToggle={() => toggle("aws_secret_access_key")}
            />

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
          </div>
        </SetupGuide>
      );
    }

    return (
            <SetupGuide
              badge="Google Cloud"
              title="Service account key for GCP deployments"
              description="GTMShip expects a Google Cloud project ID, a service account JSON key, and a region. For the current codebase, that account provisions networking, Cloud SQL, Cloud Storage, Cloud Run, and the runtime service account."
              consolePath="Google Cloud Console -> IAM & Admin -> Service Accounts -> choose the service account -> Keys -> Add key -> Create new key -> JSON"
              note="Create the service account first, grant only the current-codebase roles below, then generate the JSON key. Google warns that exported service account keys are sensitive long-lived credentials, so keep them out of source control."
              permissions={gcpPermissionGroups}
              steps={gcpSetupSteps}
              links={gcpLinks}
            >
        <div className="grid gap-4">
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
            <FieldLabel>Service account key JSON</FieldLabel>
            <textarea
              value={gcpServiceAccountKey}
              onChange={(event) => setGcpServiceAccountKey(event.target.value)}
              placeholder={
                storedSecrets.gcp_service_account_key && !gcpServiceAccountKey
                  ? "Stored JSON key on file. Paste a new JSON key to replace it."
                  : '{"type":"service_account","project_id":"..."}'
              }
              rows={7}
              spellCheck={false}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 font-mono text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
            />
            <p className="text-xs leading-5 text-zinc-500">
              {gcpServiceAccountKey
                ? "This new JSON key will replace the stored service account when you save."
                : storedSecrets.gcp_service_account_key
                  ? "A service account key is already stored. Leave this blank to keep it unchanged."
                  : "Paste the full JSON file contents from Google Cloud here."}
            </p>
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
        </div>
      </SetupGuide>
    );
  };

  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[28px] border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-950">
          <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="absolute bottom-0 left-8 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />

          <div className="relative p-6 sm:p-8">
            <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-400">
                  <ShieldCheck size={12} />
                  Environment and credential setup
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Settings
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
                  Configure the model provider GTMShip should use, keep deployment
                  credentials in one place, and tailor the cloud setup flow to
                  the provider your team actually uses.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                    <Bot size={13} />
                    AI
                  </div>
                  <p className="mt-3 text-sm font-medium text-white">Claude or OpenAI</p>
                  <p className="mt-1 text-sm leading-6 text-zinc-500">
                    Save one or both API keys and switch the default provider here.
                  </p>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                    <Cloud size={13} />
                    Cloud
                  </div>
                  <p className="mt-3 text-sm font-medium text-white">AWS or Google Cloud</p>
                  <p className="mt-1 text-sm leading-6 text-zinc-500">
                    Pick one primary deployment target and keep the alternate
                    setup guide tucked away until you need it.
                  </p>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                    <KeyRound size={13} />
                    Secrets
                  </div>
                  <p className="mt-3 text-sm font-medium text-white">Stored without forced rewrites</p>
                  <p className="mt-1 text-sm leading-6 text-zinc-500">
                    Leave masked values blank to keep the existing secret, or
                    paste a replacement only when you want to rotate it.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)]">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <Bot size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">AI provider</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Choose the default model provider for GTMShip and keep the
                  corresponding API key ready.
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

            <div className="mt-6 space-y-4">
              {aiProvider === "claude" ? (
                <SecretInput
                  label="Anthropic API key"
                  id="anthropic_api_key"
                  value={anthropicKey}
                  onChange={setAnthropicKey}
                  placeholder="sk-ant-..."
                  stored={storedSecrets.anthropic_api_key}
                  showValue={Boolean(showKeys.anthropic_api_key)}
                  onToggle={() => toggle("anthropic_api_key")}
                />
              ) : (
                <SecretInput
                  label="OpenAI API key"
                  id="openai_api_key"
                  value={openaiKey}
                  onChange={setOpenaiKey}
                  placeholder="sk-..."
                  stored={storedSecrets.openai_api_key}
                  showValue={Boolean(showKeys.openai_api_key)}
                  onToggle={() => toggle("openai_api_key")}
                />
              )}

              <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div className="space-y-2.5">
                  <FieldLabel>Live model search</FieldLabel>
                  <input
                    value={activeModelSearch}
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
                  <p className="text-xs leading-5 text-zinc-500">
                    We query the {AI_PROVIDER_LABELS[aiProvider]} models API live
                    using the key above, or the saved key in Settings if this
                    field is blank.
                  </p>
                </div>

                <div className="space-y-2.5">
                  <FieldLabel>Default model</FieldLabel>
                  <select
                    value={activeModel}
                    onChange={(event) =>
                      setSelectedModels((current) => ({
                        ...current,
                        [aiProvider]: event.target.value,
                      }))
                    }
                    disabled={!activeProviderHasKey || activeModelLoading || activeModelOptions.length === 0}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">
                      {!activeProviderHasKey
                        ? `Add a ${AI_PROVIDER_LABELS[aiProvider]} API key to load models`
                        : activeModelLoading
                          ? "Loading live models..."
                          : "Select a model"}
                    </option>
                    {activeModelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName === model.id
                          ? model.id
                          : `${model.displayName} (${model.id})`}
                      </option>
                    ))}
                  </select>
                  <p
                    className={`text-xs leading-5 ${
                      activeModelError ? "text-red-400" : "text-zinc-500"
                    }`}
                  >
                    {activeModelError
                      ? activeModelError
                      : !activeProviderHasKey
                        ? `Enter or save a ${AI_PROVIDER_LABELS[aiProvider]} API key to populate the dropdown.`
                        : activeModelLoading
                          ? `Looking up live ${AI_PROVIDER_LABELS[aiProvider]} models...`
                          : activeModel
                            ? `All GTMShip AI calls use ${activeModel} once you save these settings.`
                            : activeProviderKeyInput.trim()
                              ? "Pick a model from the live results before saving."
                              : "Choose the model GTMShip should use for chat, agents, and workflow generation."}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <FolderOpen size={18} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Workflow Studio</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Point the editor at an existing project root when you want to
                  work outside the default local workspace.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-2.5">
              <FieldLabel optional>Custom project root</FieldLabel>
              <input
                value={projectRoot}
                onChange={(event) => setProjectRoot(event.target.value)}
                placeholder="/absolute/path/to/your/gtmship-project"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
              />
              <p className="text-xs leading-5 text-zinc-500">
                By default, workflows live in{" "}
                <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                  ~/.gtmship/projects/default
                </code>
                . Leave this blank if you want GTMShip to keep using that location.
              </p>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
              <ShieldCheck size={18} />
            </div>
            <div className="max-w-3xl">
              <h2 className="text-lg font-semibold text-white">
                Connection auth source of truth
              </h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">
                GTMShip always writes credentials into local encrypted storage first.
                In secret-manager mode we replicate to the configured backend in the
                background, and deployments wait for healthy replicas before they sync.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
            <div>
              <FieldLabel>Auth routing mode</FieldLabel>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {[
                  {
                    value: "proxy" as const,
                    title: "Proxy server",
                    body:
                      "Connections and refreshes resolve locally through auth-service. Local storage remains authoritative.",
                  },
                  {
                    value: "secret_manager" as const,
                    title: "Secret manager",
                    body:
                      "Connections still write locally first, then sync to Secret Manager. Deploys only proceed once replicas are healthy.",
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
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                      {option.body}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-white">Current health</p>
                <span
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                    authStrategyHealthTone
                  }`}
                >
                  {authStrategyStatus?.status || "unknown"}
                </span>
              </div>

              <div className="mt-4 space-y-2 text-sm text-zinc-400">
                <p>
                  <span className="text-zinc-500">Saved mode:</span>{" "}
                  {authStrategyStatus?.mode || "proxy"}
                </p>
                <p>
                  <span className="text-zinc-500">Configured backends:</span>{" "}
                  {configuredBackends.length}
                </p>
                <p>
                  <span className="text-zinc-500">Replica coverage:</span>{" "}
                  {authStrategyStatus?.replicaSummary.active || 0}/
                  {authStrategyStatus?.replicaSummary.expectedReplicas || 0} active
                </p>
              </div>

              {configuredBackends.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {configuredBackends.map((backend) => (
                    <div
                      key={`${backend.kind}-${backend.region || backend.projectId || "default"}`}
                      className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400"
                    >
                      <p className="font-medium text-zinc-200">{backend.kind}</p>
                      <p className="mt-1 text-zinc-500">
                        {backend.region
                          ? `Region: ${backend.region}`
                          : backend.projectId
                            ? `Project: ${backend.projectId}`
                            : "Default target"}
                        {backend.secretPrefix
                          ? ` • Prefix: ${backend.secretPrefix}`
                          : ""}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-xs leading-5 text-zinc-500">
                  Configure AWS or GCP credentials above before enabling secret
                  manager mode.
                </p>
              )}

              {authStrategyBackfill ? (
                <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3 text-xs text-zinc-400">
                  <p className="font-medium text-zinc-200">Last save backfill</p>
                  <p className="mt-2">
                    Connections: {authStrategyBackfill.connections?.syncedReplicas || 0} replicas synced across{" "}
                    {authStrategyBackfill.connections?.activeConnections || 0} active connections.
                  </p>
                  <p className="mt-1">
                    Deployments: {authStrategyBackfill.deployments?.updated || 0} updated,{" "}
                    {authStrategyBackfill.deployments?.skipped || 0} skipped.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-zinc-800 bg-zinc-950/70 p-6 sm:p-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
              <Cloud size={12} />
              Cloud setup
            </div>
            <h2 className="mt-4 text-2xl font-semibold text-white">
              Deployment credentials for your primary cloud
            </h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">
              Most teams only need one cloud here. Choose the provider you use,
              keep that setup guide front and center, and expand the alternate
              path only if you need it later.
            </p>
          </div>

          <div className="mt-8 space-y-6">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-2xl">
                  <FieldLabel>Which cloud do you use?</FieldLabel>
                  <h3 className="mt-3 text-xl font-semibold text-white">
                    Choose the setup guide GTMShip should open by default
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-500">
                    We save this preference in Settings, keep the selected cloud
                    expanded, and tuck the alternate provider into a secondary
                    section below.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {cloudProviders.map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => { setCloudProvider(provider); setCredentialTestResult(null); }}
                      className={`rounded-2xl border px-5 py-4 text-left transition-colors ${
                        cloudProvider === provider
                          ? "border-blue-500 bg-blue-500/10 text-white"
                          : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                      }`}
                    >
                      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                        Primary cloud
                      </p>
                      <p className="mt-2 text-sm font-medium">
                        {CLOUD_PROVIDER_LABELS[provider]}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {renderCloudSetupGuide(cloudProvider)}

            <details className="group rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <summary className="flex cursor-pointer list-none flex-col gap-2 text-left sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                    Other setup guide
                  </p>
                  <p className="mt-2 text-sm font-medium text-white">
                    View {CLOUD_PROVIDER_LABELS[alternateCloudProvider]} credentials instead
                  </p>
                </div>
                <p className="text-sm text-zinc-500 transition-colors group-open:text-zinc-300">
                  Expand to see the alternate provider path
                </p>
              </summary>

              <div className="mt-6 border-t border-zinc-800 pt-6">
                {renderCloudSetupGuide(alternateCloudProvider)}
              </div>
            </details>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-purple-800/50 bg-purple-950/30 p-3 text-purple-400">
              <Brain size={18} />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white">Memory</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">
                Knowledge saved by AI agents across conversations. Agents
                automatically recall relevant memories in future sessions.
              </p>
            </div>
            {memories.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Delete all ${memories.length} memories?`)) return;
                  const ids = memories.map((m) => m.id);
                  await api.deleteMemories(ids);
                  loadMemories();
                }}
                className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-700 hover:text-red-400"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              />
              <input
                value={memoryFilter.q}
                onChange={(e) =>
                  setMemoryFilter((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="Search memories..."
                className="w-48 rounded-lg border border-zinc-800 bg-zinc-950/90 py-1.5 pl-8 pr-3 text-xs text-white placeholder-zinc-600 outline-none focus:border-purple-600"
              />
            </div>
            <select
              value={memoryFilter.scope}
              onChange={(e) =>
                setMemoryFilter((f) => ({ ...f, scope: e.target.value }))
              }
              className="rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-1.5 text-xs text-white outline-none focus:border-purple-600"
            >
              <option value="">All scopes</option>
              <option value="app">App</option>
              <option value="workflow">Workflow</option>
            </select>
            <select
              value={memoryFilter.category}
              onChange={(e) =>
                setMemoryFilter((f) => ({ ...f, category: e.target.value }))
              }
              className="rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-1.5 text-xs text-white outline-none focus:border-purple-600"
            >
              <option value="">All categories</option>
              <option value="integration">Integration</option>
              <option value="business">Business</option>
              <option value="workflow">Workflow</option>
              <option value="general">General</option>
            </select>
          </div>

          <div className="mt-4 max-h-[420px] space-y-2 overflow-y-auto">
            {memoriesLoading ? (
              <div className="flex items-center gap-2 py-8 justify-center text-xs text-zinc-500">
                <Loader2 size={14} className="animate-spin" />
                Loading memories...
              </div>
            ) : memories.length === 0 ? (
              <div className="py-8 text-center text-sm text-zinc-500">
                No memories saved yet. AI agents will save knowledge here
                during conversations.
              </div>
            ) : (
              memories.map((memory) => (
                <div
                  key={memory.id}
                  className="group flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 leading-relaxed">
                      {memory.content}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                      <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">
                        {memory.category}
                      </span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                        {memory.scope}
                        {memory.workflowId ? `: ${memory.workflowId}` : ""}
                      </span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500">
                        via {memory.source}
                      </span>
                      <span className="text-zinc-600">
                        {new Date(memory.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={deletingMemoryIds.has(memory.id)}
                    onClick={async () => {
                      setDeletingMemoryIds((s) => new Set(s).add(memory.id));
                      try {
                        await api.deleteMemory(memory.id);
                        setMemories((ms) =>
                          ms.filter((m) => m.id !== memory.id)
                        );
                      } finally {
                        setDeletingMemoryIds((s) => {
                          const next = new Set(s);
                          next.delete(memory.id);
                          return next;
                        });
                      }
                    }}
                    className="shrink-0 rounded-lg p-1.5 text-zinc-600 opacity-0 transition-all group-hover:opacity-100 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                  >
                    {deletingMemoryIds.has(memory.id) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Save settings</h2>
              <p className={`mt-1 text-sm ${saveError ? "text-red-400" : "text-zinc-500"}`}>
                {saveError ||
                  "Stored secrets stay untouched unless you paste a new value before saving."}
              </p>
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Saving...
                </>
              ) : saved ? (
                <>
                  <CheckCircle size={16} />
                  Saved
                </>
              ) : (
                <>
                  <Save size={16} />
                  Save Settings
                </>
              )}
            </button>
          </div>
        </section>

        {(cloudProvider === "gcp"
          ? storedSecrets.gcp_service_account_key
          : storedSecrets.aws_secret_access_key) && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Test {CLOUD_PROVIDER_LABELS[cloudProvider]} credentials
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Verify the stored credentials can authenticate with{" "}
                  {CLOUD_PROVIDER_LABELS[cloudProvider]}.
                </p>
              </div>

              <button
                type="button"
                onClick={testCloudCredentials}
                disabled={testingCredentials}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testingCredentials ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <ShieldCheck size={16} />
                    Test Credentials
                  </>
                )}
              </button>
            </div>

            {credentialTestResult && (
              <div
                className={`mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
                  credentialTestResult.valid
                    ? "border-green-800 bg-green-900/20 text-green-400"
                    : "border-red-800 bg-red-900/20 text-red-400"
                }`}
              >
                {credentialTestResult.valid ? (
                  <>
                    <CheckCircle size={14} />
                    Credentials valid — authenticated as{" "}
                    <span className="font-mono text-xs">
                      {credentialTestResult.identity}
                    </span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={14} />
                    {credentialTestResult.error || "Credential validation failed."}
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
