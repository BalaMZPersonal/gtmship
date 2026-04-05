import { prisma } from "./db.js";
import { getConnectionAuthStrategyStatus } from "./auth-strategy.js";
import { getSharedOAuthProviderConfig } from "./shared-oauth.js";

export const SETUP_STATE_SETTING_KEY = "setup_state_v1";

export const SETUP_STEP_IDS = [
  "ai",
  "cloud",
  "secret_storage",
  "workspace",
  "oauth_apps",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepStatus =
  | "complete"
  | "incomplete"
  | "skipped"
  | "blocked";
export type SetupOverallStatus = "complete" | "incomplete";

export interface PersistedSetupStepState {
  skipped?: boolean;
  choice?: string;
}

export interface PersistedSetupState {
  version: 1;
  dismissedAt?: string | null;
  steps?: Partial<Record<SetupStepId, PersistedSetupStepState>>;
}

export interface SetupStepRecord {
  id: SetupStepId;
  title: string;
  optional: boolean;
  status: SetupStepStatus;
  summary: string;
  missing: string[];
  blockedBy: string[];
}

export interface SetupStatusResponse {
  overallStatus: SetupOverallStatus;
  dismissed: boolean;
  progress: {
    completed: number;
    total: number;
  };
  steps: SetupStepRecord[];
  preferences: PersistedSetupState;
}

interface SetupDerivationInput {
  settings: Record<string, string | null>;
  secretPresence: Record<string, boolean>;
  preferences: PersistedSetupState;
  authStrategy: Awaited<ReturnType<typeof getConnectionAuthStrategyStatus>>;
  sharedOAuth: {
    google: {
      hasCredentials: boolean;
    };
  };
}

function readStepPreference(
  preferences: PersistedSetupState,
  stepId: SetupStepId
): PersistedSetupStepState {
  return preferences.steps?.[stepId] || {};
}

function normalizeChoice(value?: string | null): string {
  return value?.trim() || "";
}

function choiceStartsWith(value: string | undefined, prefix: string): boolean {
  return normalizeChoice(value).startsWith(prefix);
}

function inferStoredCloudProvider(
  secretPresence: Record<string, boolean>,
  settings: Record<string, string | null>
): "aws" | "gcp" | null {
  if (secretPresence.gcp_service_account_key || normalizeChoice(settings.gcp_project_id)) {
    return "gcp";
  }

  if (secretPresence.aws_secret_access_key || normalizeChoice(settings.aws_access_key_id)) {
    return "aws";
  }

  return null;
}

function inferConfiguredCloudProvider(
  settings: Record<string, string | null>,
  secretPresence: Record<string, boolean>
): "aws" | "gcp" {
  if (settings.cloud_provider === "gcp" || inferStoredCloudProvider(secretPresence, settings) === "gcp") {
    return "gcp";
  }

  return "aws";
}

function resolveAiStep(input: SetupDerivationInput): SetupStepRecord {
  const preference = readStepPreference(input.preferences, "ai");
  if (preference.skipped || preference.choice === "later") {
    return {
      id: "ai",
      title: "AI provider",
      optional: false,
      status: "skipped",
      summary: "You chose to configure AI later.",
      missing: [],
      blockedBy: [],
    };
  }

  const provider =
    input.settings.ai_provider === "openai" ? "openai" : "claude";
  const providerLabel = provider === "openai" ? "OpenAI" : "Claude";
  const hasKey =
    provider === "openai"
      ? input.secretPresence.openai_api_key
      : input.secretPresence.anthropic_api_key;
  const configuredModel =
    provider === "openai"
      ? input.settings.openai_model || "gpt-4o"
      : input.settings.anthropic_model || "claude-sonnet-4-6";

  if (!hasKey) {
    return {
      id: "ai",
      title: "AI provider",
      optional: false,
      status: "incomplete",
      summary: `Choose ${providerLabel} and add an API key to use GTMShip AI features.`,
      missing: [`${providerLabel} API key`],
      blockedBy: [],
    };
  }

  return {
    id: "ai",
    title: "AI provider",
    optional: false,
    status: "complete",
    summary: `${providerLabel} is ready with ${configuredModel}.`,
    missing: [],
    blockedBy: [],
  };
}

function resolveCloudStep(input: SetupDerivationInput): SetupStepRecord {
  const preference = readStepPreference(input.preferences, "cloud");
  const configuredProvider = inferConfiguredCloudProvider(
    input.settings,
    input.secretPresence
  );
  const providerFromChoice = normalizeChoice(preference.choice).split(":")[1];
  const provider =
    providerFromChoice === "gcp" || providerFromChoice === "aws"
      ? providerFromChoice
      : configuredProvider;
  const providerLabel = provider === "gcp" ? "Google Cloud" : "AWS";
  const cloudChoice = normalizeChoice(preference.choice);

  if (preference.skipped || cloudChoice === "later") {
    return {
      id: "cloud",
      title: "Cloud deploy target",
      optional: false,
      status: "skipped",
      summary: "You chose to configure cloud deployment later.",
      missing: [],
      blockedBy: [],
    };
  }

  const hasStoredAws =
    Boolean(normalizeChoice(input.settings.aws_access_key_id)) &&
    input.secretPresence.aws_secret_access_key;
  const hasStoredGcp =
    input.secretPresence.gcp_service_account_key &&
    Boolean(
      normalizeChoice(input.settings.gcp_project_id) ||
        process.env.GOOGLE_CLOUD_PROJECT
    );

  if (choiceStartsWith(cloudChoice, "environment:")) {
    return {
      id: "cloud",
      title: "Cloud deploy target",
      optional: false,
      status: "complete",
      summary: `${providerLabel} is configured to use environment or default credentials.`,
      missing: [],
      blockedBy: [],
    };
  }

  const hasStoredCredentials =
    provider === "aws" ? hasStoredAws : hasStoredGcp;

  if (hasStoredCredentials) {
    return {
      id: "cloud",
      title: "Cloud deploy target",
      optional: false,
      status: "complete",
      summary: `${providerLabel} credentials are saved in GTMShip.`,
      missing: [],
      blockedBy: [],
    };
  }

  const missing =
    provider === "aws"
      ? ["AWS access key", "AWS secret access key"]
      : ["GCP project ID", "GCP service account key"];

  return {
    id: "cloud",
    title: "Cloud deploy target",
    optional: false,
    status: "incomplete",
    summary: `Choose how GTMShip should access ${providerLabel} before deploying.`,
    missing,
    blockedBy: [],
  };
}

function resolveSecretStorageStep(input: SetupDerivationInput): SetupStepRecord {
  const preference = readStepPreference(input.preferences, "secret_storage");
  if (preference.skipped || preference.choice === "later") {
    return {
      id: "secret_storage",
      title: "Secret storage",
      optional: false,
      status: "skipped",
      summary: "You chose to revisit connection secret storage later.",
      missing: [],
      blockedBy: [],
    };
  }

  const strategy = input.authStrategy;
  if (strategy.mode !== "secret_manager") {
    return {
      id: "secret_storage",
      title: "Secret storage",
      optional: false,
      status: "complete",
      summary: "Using proxy mode with local encrypted storage as the source of truth.",
      missing: [],
      blockedBy: [],
    };
  }

  if (strategy.configuredBackends.length === 0) {
    return {
      id: "secret_storage",
      title: "Secret storage",
      optional: false,
      status: "blocked",
      summary: "Secret manager mode is selected, but no secret backend is configured yet.",
      missing: ["Cloud credentials for at least one secret manager backend"],
      blockedBy: ["Add AWS or GCP credentials before switching to secret manager mode."],
    };
  }

  if (strategy.status === "degraded") {
    return {
      id: "secret_storage",
      title: "Secret storage",
      optional: false,
      status: "blocked",
      summary: "Secret manager sync is configured, but replica health still needs attention.",
      missing: [],
      blockedBy: ["Wait for replica health to recover or switch back to proxy mode."],
    };
  }

  return {
    id: "secret_storage",
    title: "Secret storage",
    optional: false,
    status: "complete",
    summary:
      strategy.status === "migrating"
        ? "Secret manager mode is enabled and replicas are still syncing."
        : "Secret manager mode is enabled and healthy.",
    missing: [],
    blockedBy: [],
  };
}

function resolveWorkspaceStep(input: SetupDerivationInput): SetupStepRecord {
  const preference = readStepPreference(input.preferences, "workspace");
  if (preference.skipped || preference.choice === "later") {
    return {
      id: "workspace",
      title: "Workspace",
      optional: true,
      status: "skipped",
      summary: "You chose to keep the default workspace for now.",
      missing: [],
      blockedBy: [],
    };
  }

  const projectRoot = normalizeChoice(input.settings.project_root);
  if (projectRoot) {
    return {
      id: "workspace",
      title: "Workspace",
      optional: true,
      status: "complete",
      summary: `Using a custom project root at ${projectRoot}.`,
      missing: [],
      blockedBy: [],
    };
  }

  return {
    id: "workspace",
    title: "Workspace",
    optional: true,
    status: "complete",
    summary: "Using the default local workspace under ~/.gtmship/projects/default.",
    missing: [],
    blockedBy: [],
  };
}

function resolveOAuthAppsStep(input: SetupDerivationInput): SetupStepRecord {
  const preference = readStepPreference(input.preferences, "oauth_apps");
  if (preference.skipped || preference.choice === "later") {
    return {
      id: "oauth_apps",
      title: "Shared OAuth apps",
      optional: true,
      status: "skipped",
      summary: "You can add shared OAuth app credentials later when you need them.",
      missing: [],
      blockedBy: [],
    };
  }

  if (input.sharedOAuth.google.hasCredentials) {
    return {
      id: "oauth_apps",
      title: "Shared OAuth apps",
      optional: true,
      status: "complete",
      summary: "Google shared OAuth credentials are configured.",
      missing: [],
      blockedBy: [],
    };
  }

  return {
    id: "oauth_apps",
    title: "Shared OAuth apps",
    optional: true,
    status: "incomplete",
    summary: "Optional: save shared OAuth app credentials to simplify Google-family connections.",
    missing: ["Google OAuth client ID", "Google OAuth client secret"],
    blockedBy: [],
  };
}

export function deriveSetupStatus(
  input: SetupDerivationInput
): SetupStatusResponse {
  const steps = [
    resolveAiStep(input),
    resolveCloudStep(input),
    resolveSecretStorageStep(input),
    resolveWorkspaceStep(input),
    resolveOAuthAppsStep(input),
  ];

  const completed = steps.filter(
    (step) => step.status === "complete" || step.status === "skipped"
  ).length;

  const requiredSteps = steps.filter((step) => !step.optional);
  const overallStatus: SetupOverallStatus = requiredSteps.every(
    (step) => step.status === "complete" || step.status === "skipped"
  )
    ? "complete"
    : "incomplete";

  return {
    overallStatus,
    dismissed: Boolean(input.preferences.dismissedAt),
    progress: {
      completed,
      total: steps.length,
    },
    steps,
    preferences: input.preferences,
  };
}

function parseSetupState(raw: string | null | undefined): PersistedSetupState {
  if (!raw) {
    return { version: 1, steps: {} };
  }

  try {
    const parsed = JSON.parse(raw) as PersistedSetupState;
    return {
      version: 1,
      dismissedAt: parsed.dismissedAt || null,
      steps: parsed.steps || {},
    };
  } catch {
    return { version: 1, steps: {} };
  }
}

export async function getPersistedSetupState(): Promise<PersistedSetupState> {
  const setting = await prisma.setting.findUnique({
    where: { key: SETUP_STATE_SETTING_KEY },
    select: { value: true },
  });

  return parseSetupState(setting?.value);
}

export async function updatePersistedSetupState(input: {
  dismissed?: boolean;
  steps?: Partial<Record<SetupStepId, PersistedSetupStepState>>;
}): Promise<PersistedSetupState> {
  const current = await getPersistedSetupState();
  const next: PersistedSetupState = {
    version: 1,
    dismissedAt:
      input.dismissed === undefined
        ? current.dismissedAt || null
        : input.dismissed
          ? new Date().toISOString()
          : null,
    steps: {
      ...(current.steps || {}),
    },
  };

  for (const stepId of SETUP_STEP_IDS) {
    const patch = input.steps?.[stepId];
    if (!patch) {
      continue;
    }

    next.steps![stepId] = {
      ...(next.steps?.[stepId] || {}),
      ...patch,
    };
  }

  await prisma.setting.upsert({
    where: { key: SETUP_STATE_SETTING_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: SETUP_STATE_SETTING_KEY, value: JSON.stringify(next) },
  });

  return next;
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  const relevantKeys = [
    "ai_provider",
    "anthropic_model",
    "openai_model",
    "cloud_provider",
    "aws_access_key_id",
    "aws_region",
    "gcp_project_id",
    "gcp_region",
    "project_root",
    "connection_secret_prefix",
    SETUP_STATE_SETTING_KEY,
  ];

  const [settings, preferences, authStrategy, googleOAuth] = await Promise.all([
    prisma.setting.findMany({
      where: {
        key: {
          in: [
            ...relevantKeys,
            "anthropic_api_key",
            "openai_api_key",
            "aws_secret_access_key",
            "gcp_service_account_key",
          ],
        },
      },
      select: {
        key: true,
        value: true,
      },
    }),
    getPersistedSetupState(),
    getConnectionAuthStrategyStatus(),
    getSharedOAuthProviderConfig("google"),
  ]);

  const settingsMap: Record<string, string | null> = {};
  const secretPresence: Record<string, boolean> = {
    anthropic_api_key: false,
    openai_api_key: false,
    aws_secret_access_key: false,
    gcp_service_account_key: false,
  };

  for (const setting of settings) {
    settingsMap[setting.key] = setting.value;
    if (setting.key in secretPresence) {
      secretPresence[setting.key] = Boolean(setting.value);
    }
  }

  return deriveSetupStatus({
    settings: settingsMap,
    secretPresence,
    preferences,
    authStrategy,
    sharedOAuth: {
      google: {
        hasCredentials: Boolean(googleOAuth?.hasCredentials),
      },
    },
  });
}
