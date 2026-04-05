import type {
  WorkflowBuildResult,
  WorkflowPreviewResult,
  WorkflowStudioMessage,
} from "./types";

function countCompletedReadOperations(preview: WorkflowPreviewResult): number {
  return preview.operations.filter(
    (operation) =>
      operation.mode === "read" &&
      typeof operation.responseStatus === "number"
  ).length;
}

function formatWarningsSuffix(preview: WorkflowPreviewResult): string {
  return preview.warnings?.length
    ? " Review the Preview tab warnings before continuing."
    : "";
}

function describePendingCheckpoint(preview: WorkflowPreviewResult): string {
  return preview.pendingApproval?.checkpoint || "the next write checkpoint";
}

export function formatDraftStatusMessage(
  preview: WorkflowPreviewResult
): string {
  const completedReadOperations = countCompletedReadOperations(preview);
  const warningsSuffix = formatWarningsSuffix(preview);

  if (preview.status === "success") {
    return completedReadOperations > 0
      ? `Draft generated. Preview completed and tested ${completedReadOperations} non-write API call(s). Not built. Not deployed.${warningsSuffix}`
      : `Draft generated. Preview completed. No non-write API calls were executed. Not built. Not deployed.${warningsSuffix}`;
  }

  if (preview.status === "needs_approval") {
    const checkpoint = describePendingCheckpoint(preview);

    return completedReadOperations > 0
      ? `Draft generated. Preview tested ${completedReadOperations} non-write API call(s) and paused at checkpoint "${checkpoint}" for approval. Approve it in Preview to continue. Not built. Not deployed.${warningsSuffix}`
      : `Draft generated. Preview paused at checkpoint "${checkpoint}" for approval before any non-write API calls completed. Approve it in Preview to continue. Not built. Not deployed.${warningsSuffix}`;
  }

  return `Draft generation completed, but preview failed. Not built. Not deployed.${warningsSuffix}`;
}

export function formatPreviewStatusMessage(
  preview: WorkflowPreviewResult
): string {
  const completedReadOperations = countCompletedReadOperations(preview);
  const warningsSuffix = formatWarningsSuffix(preview);

  if (preview.status === "success") {
    return completedReadOperations > 0
      ? `Preview completed and tested ${completedReadOperations} non-write API call(s).${warningsSuffix}`
      : `Preview completed. No non-write API calls were executed.${warningsSuffix}`;
  }

  if (preview.status === "needs_approval") {
    return `Preview paused at checkpoint "${describePendingCheckpoint(preview)}" for approval. The user must approve this in the Preview section before the agent continues.${warningsSuffix}`;
  }

  return preview.error
    ? `Preview failed: ${preview.error}`
    : "Preview failed.";
}

export function formatBuildStatusMessage(build: WorkflowBuildResult): string {
  const preview = build.preview;
  const warningsSuffix = preview ? formatWarningsSuffix(preview) : "";

  if (build.status === "success") {
    if (preview?.status === "needs_approval") {
      return `Build completed and packaged an artifact. Preview paused at checkpoint "${describePendingCheckpoint(preview)}" during build, and packaging continued without user approval. This did not deploy the workflow.${warningsSuffix}`;
    }

    return `Build completed and packaged an artifact. This did not deploy the workflow.${warningsSuffix}`;
  }

  const buildError = build.error?.trim();
  return buildError
    ? `Build failed. ${buildError} This did not deploy the workflow.${warningsSuffix}`
    : `Build failed. This did not deploy the workflow.${warningsSuffix}`;
}

function getLatestUserMessageContent(
  messages: WorkflowStudioMessage[]
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }

  return "";
}

export function didUserExplicitlyRequestBuild(
  messages: WorkflowStudioMessage[]
): boolean {
  const latestUserMessage = getLatestUserMessageContent(messages).toLowerCase();
  if (!latestUserMessage) {
    return false;
  }

  if (
    /\b(do not|don't|dont|not yet|later|wait to)\b[\s\S]{0,40}\b(build|package|ship|deploy|finish|complete)\b/.test(
      latestUserMessage
    )
  ) {
    return false;
  }

  return /\b(build|package|ship|deploy|finish|complete)\b/.test(
    latestUserMessage
  );
}
