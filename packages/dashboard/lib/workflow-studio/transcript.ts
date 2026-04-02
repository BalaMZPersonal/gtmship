import type {
  WorkflowAccessRequirement,
  WorkflowBuildResult,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowStudioToolInvocation,
  WorkflowValidationReport,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getToolInvocations(
  message: WorkflowStudioMessage
): WorkflowStudioToolInvocation[] {
  if (message.toolInvocations?.length) {
    return message.toolInvocations;
  }

  if (!message.parts?.length) {
    return [];
  }

  return message.parts.flatMap((part) =>
    part.type === "tool-invocation" && part.toolInvocation
      ? [part.toolInvocation as WorkflowStudioToolInvocation]
      : []
  );
}

function asArtifact(value: unknown): WorkflowStudioArtifact | null {
  if (!isObject(value)) {
    return null;
  }

  return "slug" in value && "code" in value
    ? (value as unknown as WorkflowStudioArtifact)
    : null;
}

function asValidation(value: unknown): WorkflowValidationReport | null {
  if (!isObject(value)) {
    return null;
  }

  return Array.isArray(value.issues) && "ok" in value
    ? (value as unknown as WorkflowValidationReport)
    : null;
}

function asPreview(value: unknown): WorkflowPreviewResult | null {
  if (!isObject(value)) {
    return null;
  }

  return typeof value.status === "string"
    ? (value as unknown as WorkflowPreviewResult)
    : null;
}

function asBuild(value: unknown): WorkflowBuildResult | null {
  if (!isObject(value)) {
    return null;
  }

  return Array.isArray(value.steps) && typeof value.status === "string"
    ? (value as unknown as WorkflowBuildResult)
    : null;
}

function asBlockedAccesses(
  value: unknown
): WorkflowAccessRequirement[] | null {
  return Array.isArray(value) ? (value as WorkflowAccessRequirement[]) : null;
}

export function deriveWorkflowStudioState(
  messages: WorkflowStudioMessage[],
  fallbackArtifact?: WorkflowStudioArtifact | null
): {
  artifact: WorkflowStudioArtifact | null;
  blockedAccesses: WorkflowAccessRequirement[];
} {
  let artifact = fallbackArtifact || null;
  let blockedAccesses: WorkflowAccessRequirement[] = [];

  for (const message of messages) {
    for (const invocation of getToolInvocations(message)) {
      if (invocation.state !== "result" || !isObject(invocation.result)) {
        continue;
      }

      const nextArtifact = asArtifact(invocation.result.artifact);
      if (nextArtifact) {
        artifact = nextArtifact;
        blockedAccesses = [];
      }

      const nextBlocked = asBlockedAccesses(invocation.result.blockedAccesses);
      if (nextBlocked) {
        blockedAccesses = nextBlocked;
      }

      const validation = asValidation(invocation.result.validation);
      if (artifact && validation) {
        artifact = {
          ...artifact,
          validation,
        };
      }

      const preview = asPreview(invocation.result.preview);
      if (artifact && preview) {
        artifact = {
          ...artifact,
          preview,
        };
      }

      const build = asBuild(invocation.result.build);
      if (artifact && build) {
        artifact = {
          ...artifact,
          build,
          validation: build.validation || artifact.validation,
          preview: build.preview || artifact.preview,
        };
      }
    }
  }

  if (artifact) {
    artifact = {
      ...artifact,
      messages,
    };
  }

  return {
    artifact,
    blockedAccesses,
  };
}
