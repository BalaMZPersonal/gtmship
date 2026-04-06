import type {
  ConnectionAuthStrategyBackend,
  ConnectionAuthStrategyStatus,
  WorkflowDeploymentPlan,
  WorkflowPlannedBinding,
  WorkflowRuntimeAuthManifest,
  WorkflowRuntimeAuthManifestProvider,
  WorkflowSecretBackendKind,
} from "./types";

const DEFAULT_SECRET_PREFIX = "gtmship-connections";

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_/.]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
}

function sanitizeSecretId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = normalized.length > 0 ? normalized : "connection-secret";
  if (!/^[A-Za-z]/.test(safe)) {
    return `s-${safe}`.slice(0, 255);
  }
  return safe.slice(0, 255);
}

function uniqueWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function cleanWarnings(warnings: string[]): string[] {
  return warnings.filter(
    (warning) =>
      !warning.includes("secret_manager auth requires deploy.auth.backend.kind")
  );
}

function resolveSecretPrefix(
  backend?: { secretPrefix?: string } | null
): string {
  const normalized = backend?.secretPrefix?.trim();
  return normalized ? sanitizeSegment(normalized) : DEFAULT_SECRET_PREFIX;
}

function buildAwsSecretRef(
  binding: WorkflowPlannedBinding,
  backend?: { secretPrefix?: string } | null
): string | undefined {
  if (!binding.resolvedConnectionId) {
    return undefined;
  }

  const prefix = resolveSecretPrefix(backend);
  return `${prefix}/${sanitizeSegment(binding.providerSlug)}/${sanitizeSegment(
    binding.resolvedConnectionId
  )}/runtime`;
}

function buildGcpSecretRef(
  binding: WorkflowPlannedBinding,
  backend?: { projectId?: string; secretPrefix?: string } | null
): string | undefined {
  if (!binding.resolvedConnectionId || !backend?.projectId) {
    return undefined;
  }

  const prefix = resolveSecretPrefix(backend);
  const secretId = sanitizeSecretId(
    `${prefix}-${binding.providerSlug}-${binding.resolvedConnectionId}`
  );
  return `projects/${backend.projectId}/secrets/${secretId}-runtime`;
}

function buildSecretRef(
  kind: WorkflowSecretBackendKind,
  binding: WorkflowPlannedBinding,
  backend?: ConnectionAuthStrategyBackend | null
): string | undefined {
  if (kind === "aws_secrets_manager") {
    return buildAwsSecretRef(binding, backend);
  }

  return buildGcpSecretRef(binding, backend);
}

function matchConfiguredBackend(
  configuredBackends: ConnectionAuthStrategyBackend[],
  kind: WorkflowSecretBackendKind
): ConnectionAuthStrategyBackend | null {
  return (
    configuredBackends.find((backend) => backend.kind === kind) || null
  );
}

export function resolveAuthStrategyBackend(input: {
  strategy: ConnectionAuthStrategyStatus;
  provider: "aws" | "gcp" | "local";
  region?: string;
  gcpProject?: string;
  requested?: {
    kind?: WorkflowSecretBackendKind;
    region?: string;
    projectId?: string;
    secretPrefix?: string;
  };
}): ConnectionAuthStrategyBackend | null {
  if (input.provider === "local") {
    return null;
  }

  const requestedKind = input.requested?.kind;
  const configured =
    requestedKind
      ? matchConfiguredBackend(input.strategy.configuredBackends, requestedKind)
      : input.provider === "aws"
        ? matchConfiguredBackend(
            input.strategy.configuredBackends,
            "aws_secrets_manager"
          )
        : matchConfiguredBackend(
            input.strategy.configuredBackends,
            "gcp_secret_manager"
          );

  const kind =
    requestedKind ||
    configured?.kind ||
    (input.provider === "aws"
      ? "aws_secrets_manager"
      : "gcp_secret_manager");

  if (kind === "aws_secrets_manager") {
    const region = input.requested?.region || input.region || configured?.region;
    if (!region) {
      return null;
    }

    return {
      kind,
      region,
      secretPrefix: input.requested?.secretPrefix || configured?.secretPrefix,
    };
  }

  const projectId =
    input.requested?.projectId || input.gcpProject || configured?.projectId;
  if (!projectId) {
    return null;
  }

  return {
    kind,
    projectId,
    secretPrefix: input.requested?.secretPrefix || configured?.secretPrefix,
  };
}

function buildManifestProviders(
  plan: WorkflowDeploymentPlan,
  backend: ConnectionAuthStrategyBackend
): WorkflowRuntimeAuthManifestProvider[] {
  const existingProviders = new Map(
    (plan.auth?.manifest?.providers || []).map((provider) => [
      provider.providerSlug,
      provider,
    ])
  );

  if (plan.bindings.length === 0) {
    return plan.auth?.manifest?.providers || [];
  }

  return plan.bindings.map((binding) => {
    const existing = existingProviders.get(binding.providerSlug);
    const secretRef = buildSecretRef(backend.kind, binding, backend);

    return {
      ...existing,
      providerSlug: binding.providerSlug,
      connectionId: binding.resolvedConnectionId || existing?.connectionId,
      secretRef: secretRef || existing?.secretRef,
    };
  });
}

function buildSecretManagerManifest(
  plan: WorkflowDeploymentPlan,
  backend: ConnectionAuthStrategyBackend
): WorkflowRuntimeAuthManifest {
  return {
    version: plan.auth?.manifest?.version || "1",
    generatedAt: new Date().toISOString(),
    providers: buildManifestProviders(plan, backend),
  };
}

function buildCloudSecretManagerWarning(plan: WorkflowDeploymentPlan): string {
  return `Cloud deployments to ${plan.provider.toUpperCase()} always use secret_manager auth. Enable Secret manager in Settings before deploying this workflow.`;
}

export function applyGlobalAuthStrategyToPlan(
  plan: WorkflowDeploymentPlan,
  strategy?: ConnectionAuthStrategyStatus | null
): WorkflowDeploymentPlan {
  if (plan.provider === "local") {
    return {
      ...plan,
      authMode: "proxy",
      auth: {
        mode: "proxy",
        legacyModeAliasUsed: plan.auth?.legacyModeAliasUsed,
      },
      warnings: uniqueWarnings(
        cleanWarnings([
          ...plan.warnings,
          ...(plan.authMode !== "proxy"
            ? [
                "Local deployments always use proxy auth through the local GTMShip auth service.",
              ]
            : []),
        ])
      ),
    };
  }

  const warnings = cleanWarnings(plan.warnings);
  if (!strategy) {
    return {
      ...plan,
      authMode: "secret_manager",
      auth: {
        mode: "secret_manager",
        backend: plan.auth?.backend,
        runtimeAccess: plan.auth?.runtimeAccess || "direct",
        manifest: plan.auth?.manifest,
        legacyModeAliasUsed: plan.auth?.legacyModeAliasUsed,
      },
      warnings: uniqueWarnings([
        ...warnings,
        buildCloudSecretManagerWarning(plan),
      ]),
    };
  }

  if (strategy.mode === "proxy") {
    return {
      ...plan,
      authMode: "secret_manager",
      auth: {
        mode: "secret_manager",
        backend: plan.auth?.backend,
        runtimeAccess: plan.auth?.runtimeAccess || "direct",
        manifest: plan.auth?.manifest,
        legacyModeAliasUsed: plan.auth?.legacyModeAliasUsed,
      },
      warnings: uniqueWarnings([
        ...warnings,
        buildCloudSecretManagerWarning(plan),
      ]),
    };
  }

  const backend = resolveAuthStrategyBackend({
    strategy,
    provider: plan.provider,
    region: plan.region,
    gcpProject: plan.gcpProject,
    requested: plan.auth?.backend,
  });

  const nextWarnings = [...warnings];
  if (!backend) {
    nextWarnings.push(
      `Secret manager auth is enabled in Settings, but no matching ${plan.provider.toUpperCase()} secret backend is configured for this workflow.`
    );
  }

  return {
    ...plan,
    authMode: "secret_manager",
    auth: {
      mode: "secret_manager",
      backend: backend || plan.auth?.backend,
      runtimeAccess: plan.auth?.runtimeAccess || "direct",
      manifest:
        backend
          ? buildSecretManagerManifest(plan, backend)
          : plan.auth?.manifest,
      legacyModeAliasUsed: plan.auth?.legacyModeAliasUsed,
    },
    warnings: uniqueWarnings(nextWarnings),
  };
}
