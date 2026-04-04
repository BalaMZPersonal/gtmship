import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";
import type {
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowTranscriptCompaction,
} from "./types";
import {
  WORKFLOW_TRANSCRIPT_HARD_LIMIT_TOKENS,
  applyTranscriptCompaction,
  buildFallbackTranscriptSummary,
  buildTranscriptCompactionPlan,
  chunkMessagesForSummary,
  createTranscriptTooLargeError,
  estimateTextTokens,
  estimateVisibleTranscriptTokens,
  formatMessagesForSummaryPrompt,
  getArtifactTranscriptCompaction,
} from "./transcript-compaction";

const summarySchema = z.object({
  summary: z.string().min(1).max(6_000),
});

async function resolveModel(): Promise<LanguageModel> {
  return createConfiguredLanguageModel();
}

function getWorkflowContext(artifact?: WorkflowStudioArtifact | null): string {
  if (!artifact) {
    return "";
  }

  return [
    artifact.title ? `Workflow title: ${artifact.title}` : "",
    artifact.slug ? `Workflow slug: ${artifact.slug}` : "",
    artifact.summary ? `Current workflow summary: ${artifact.summary}` : "",
    artifact.chatSummary ? `Existing chat summary: ${artifact.chatSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function summarizeTranscriptChunk(input: {
  previousSummary?: string;
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: LanguageModel;
}): Promise<string> {
  const model = input.resolvedModel ?? (await resolveModel());
  const prompt = [
    "Update the rolling summary for an older GTMShip Workflow Studio transcript.",
    "Keep only durable context needed for future workflow generation and repair.",
    "Preserve the workflow goal, integrations or URLs, connection state, docs or command findings, validation/preview/build failures, fixes attempted, pending approvals, and open blockers.",
    "Drop chit-chat, duplicate detail, and incidental back-and-forth.",
    "Write a concise cumulative summary that can replace the archived messages.",
    "",
    input.previousSummary?.trim()
      ? ["Current rolling summary:", input.previousSummary.trim(), ""].join("\n")
      : "",
    getWorkflowContext(input.currentArtifact)
      ? [getWorkflowContext(input.currentArtifact), ""].join("\n")
      : "",
    "Archived transcript chunk:",
    formatMessagesForSummaryPrompt(input.messages),
  ]
    .filter(Boolean)
    .join("\n");

  const result = await generateObject({
    model,
    schema: summarySchema,
    system:
      "Return only an updated rolling summary for archived workflow-chat context. Keep it compact and factual.",
    prompt,
  });

  return result.object.summary.trim();
}

export async function summarizeWorkflowTranscriptMessages(input: {
  previousSummary?: string;
  messagesToCompact: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: LanguageModel;
}): Promise<string> {
  let summary = input.previousSummary?.trim() || "";
  const chunks = chunkMessagesForSummary(input.messagesToCompact);

  for (const chunk of chunks) {
    try {
      summary = await summarizeTranscriptChunk({
        previousSummary: summary,
        messages: chunk,
        currentArtifact: input.currentArtifact,
        resolvedModel: input.resolvedModel,
      });
    } catch {
      summary = buildFallbackTranscriptSummary({
        previousSummary: summary,
        messages: chunk,
      });
    }
  }

  return summary.trim();
}

export async function compactWorkflowTranscriptIfNeeded(input: {
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  additionalText?: string;
  resolvedModel?: LanguageModel;
  triggerTokens?: number;
  recentTokens?: number;
}): Promise<{
  messages: WorkflowStudioMessage[];
  transcriptCompaction?: WorkflowTranscriptCompaction;
  changed: boolean;
}> {
  let visibleMessages = input.messages;
  let transcriptCompaction = getArtifactTranscriptCompaction(input.currentArtifact);
  let changed = false;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const plan = buildTranscriptCompactionPlan({
      messages: visibleMessages,
      compaction: transcriptCompaction,
      additionalText: input.additionalText,
      triggerTokens: input.triggerTokens,
      recentTokens: input.recentTokens,
    });

    if (!plan) {
      break;
    }

    const summary = await summarizeWorkflowTranscriptMessages({
      previousSummary: plan.existingSummary,
      messagesToCompact: plan.messagesToArchive,
      currentArtifact: input.currentArtifact,
      resolvedModel: input.resolvedModel,
    });

    const applied = applyTranscriptCompaction({
      messages: visibleMessages,
      compaction: transcriptCompaction,
      summary,
      messagesToArchive: plan.messagesToArchive,
      recentMessages: plan.recentMessages,
    });

    visibleMessages = applied.messages;
    transcriptCompaction = applied.transcriptCompaction;
    changed = true;
  }

  const finalEstimate = estimateVisibleTranscriptTokens({
    messages: visibleMessages,
    compaction: transcriptCompaction,
    additionalText: input.additionalText,
  });

  if (finalEstimate > WORKFLOW_TRANSCRIPT_HARD_LIMIT_TOKENS) {
    throw createTranscriptTooLargeError(
      estimateTextTokens(input.additionalText) || finalEstimate,
      false
    );
  }

  return {
    messages: visibleMessages,
    transcriptCompaction,
    changed,
  };
}
