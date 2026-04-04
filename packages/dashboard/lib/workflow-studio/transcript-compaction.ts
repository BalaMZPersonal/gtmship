import type {
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowStudioToolInvocation,
  WorkflowTranscriptCompaction,
} from "./types";

export const WORKFLOW_TRANSCRIPT_COMPACTION_VERSION = 1 as const;
export const WORKFLOW_TRANSCRIPT_TRIGGER_TOKENS = 24_000;
export const WORKFLOW_TRANSCRIPT_HARD_LIMIT_TOKENS = 30_000;
export const WORKFLOW_TRANSCRIPT_RECENT_TOKENS = 10_000;
export const WORKFLOW_TRANSCRIPT_SUMMARY_CHUNK_TOKENS = 6_000;
export const WORKFLOW_TRANSCRIPT_MAX_PENDING_MESSAGE_TOKENS = 18_000;

const SUMMARY_MESSAGE_PREFIX = "Earlier conversation was compacted to keep this workflow within the model context budget.";
const SUMMARY_ANNOTATION_TYPE = "workflow-transcript-compaction";
const TOOL_ARG_MAX_CHARS = 500;
const TOOL_RESULT_MAX_CHARS = 1_600;
const FALLBACK_SUMMARY_MAX_CHARS = 4_000;
const PROMPT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /maximum context length/i,
  /context length exceeded/i,
  /context window/i,
  /too many tokens/i,
  /tokens?\s*>\s*\d+\s*maximum/i,
  /input.*too long/i,
];

export interface WorkflowTranscriptCompactionPlan {
  existingSummary: string;
  messagesToArchive: WorkflowStudioMessage[];
  recentMessages: WorkflowStudioMessage[];
  estimatedTokensBefore: number;
}

function clampText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}\n... (truncated)`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolInvocationPart(
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

export function getWorkflowMessageText(message: WorkflowStudioMessage): string {
  const content = message.content?.trim();
  if (content) {
    return content;
  }

  if (!message.parts?.length) {
    return "";
  }

  return message.parts
    .map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : ""
    )
    .join("\n")
    .trim();
}

export function estimateTextTokens(value?: string | null): number {
  const text = (value || "").trim();
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function formatToolInvocationForSummary(
  invocation: WorkflowStudioToolInvocation
): string {
  const lines = [`tool=${invocation.toolName} state=${invocation.state}`];

  if (invocation.args && Object.keys(invocation.args).length > 0) {
    lines.push(
      `args=${clampText(stringifyUnknown(invocation.args), TOOL_ARG_MAX_CHARS)}`
    );
  }

  if (invocation.result !== undefined) {
    lines.push(
      `result=${clampText(
        stringifyUnknown(invocation.result),
        TOOL_RESULT_MAX_CHARS
      )}`
    );
  }

  return lines.join("\n");
}

function getWorkflowMessageToolSummary(message: WorkflowStudioMessage): string {
  return getToolInvocationPart(message)
    .map(formatToolInvocationForSummary)
    .filter(Boolean)
    .join("\n\n");
}

export function formatMessageForCompactionSummary(
  message: WorkflowStudioMessage
): string {
  const content = getWorkflowMessageModelText(message);

  if (!content) {
    return "";
  }

  return `${message.role.toUpperCase()}: ${content}`;
}

export function getWorkflowMessageModelText(
  message: WorkflowStudioMessage
): string {
  const text = getWorkflowMessageText(message);
  const toolText = getWorkflowMessageToolSummary(message);

  return [text, toolText].filter(Boolean).join("\n\n").trim();
}

export function normalizeWorkflowMessagesForModel(
  messages: WorkflowStudioMessage[]
): WorkflowStudioMessage[] {
  const normalized = messages
    .map((message): WorkflowStudioMessage | null => {
      const content = getWorkflowMessageModelText(message);
      if (!content) {
        return null;
      }

      return {
        id: message.id,
        role:
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "system"
            ? message.role
            : "assistant",
        content,
        createdAt: message.createdAt,
      } satisfies WorkflowStudioMessage;
    })
    .filter((message): message is WorkflowStudioMessage => Boolean(message));

  const lastUserMessageIndex = [...normalized]
    .map((message) => message.role)
    .lastIndexOf("user");

  if (lastUserMessageIndex === -1) {
    return [];
  }

  return normalized.slice(0, lastUserMessageIndex + 1);
}

export function estimateMessageTokens(message: WorkflowStudioMessage): number {
  const summaryText = formatMessageForCompactionSummary(message);
  return estimateTextTokens(summaryText) + 8;
}

export function estimateMessagesTokens(
  messages: WorkflowStudioMessage[]
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0
  );
}

export function normalizeTranscriptCompaction(
  compaction?: WorkflowTranscriptCompaction | null
): WorkflowTranscriptCompaction | undefined {
  if (!compaction?.summary?.trim()) {
    return undefined;
  }

  return {
    version: WORKFLOW_TRANSCRIPT_COMPACTION_VERSION,
    summary: compaction.summary.trim(),
    compactedAt: compaction.compactedAt || new Date().toISOString(),
    archivedMessages: Array.isArray(compaction.archivedMessages)
      ? compaction.archivedMessages
      : [],
  };
}

export function createTranscriptSummaryMessage(
  summary: string,
  compactedAt = new Date().toISOString()
): WorkflowStudioMessage {
  const normalizedSummary = summary.trim();

  return {
    id: `workflow-transcript-summary-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    role: "system",
    content: [
      SUMMARY_MESSAGE_PREFIX,
      "",
      normalizedSummary,
    ].join("\n"),
    createdAt: compactedAt,
    annotations: [
      {
        type: SUMMARY_ANNOTATION_TYPE,
        summary: normalizedSummary,
        compactedAt,
      },
    ],
  };
}

function getSummaryAnnotation(
  message: WorkflowStudioMessage
): { summary?: string; compactedAt?: string } | null {
  if (!Array.isArray(message.annotations)) {
    return null;
  }

  const annotation = message.annotations.find((value) => {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      (value as { type?: string }).type === SUMMARY_ANNOTATION_TYPE
    );
  }) as { summary?: string; compactedAt?: string } | undefined;

  return annotation || null;
}

export function isTranscriptSummaryMessage(
  message: WorkflowStudioMessage
): boolean {
  if (getSummaryAnnotation(message)) {
    return true;
  }

  return Boolean(
    message.role === "system" &&
      message.content?.startsWith(SUMMARY_MESSAGE_PREFIX)
  );
}

export function getTranscriptSummaryFromMessage(
  message: WorkflowStudioMessage
): string {
  const annotation = getSummaryAnnotation(message);
  if (annotation?.summary?.trim()) {
    return annotation.summary.trim();
  }

  const text = (message.content || "").trim();
  if (!text.startsWith(SUMMARY_MESSAGE_PREFIX)) {
    return "";
  }

  return text.slice(SUMMARY_MESSAGE_PREFIX.length).trim();
}

export function getVisibleTranscriptState(input: {
  messages: WorkflowStudioMessage[];
  compaction?: WorkflowTranscriptCompaction | null;
}): {
  summary: string;
  rawMessages: WorkflowStudioMessage[];
  visibleMessages: WorkflowStudioMessage[];
} {
  const normalizedCompaction = normalizeTranscriptCompaction(input.compaction);
  const extractedSummary = input.messages.find(isTranscriptSummaryMessage);
  const summary =
    normalizedCompaction?.summary ||
    (extractedSummary ? getTranscriptSummaryFromMessage(extractedSummary) : "");
  const rawMessages = input.messages.filter(
    (message) => !isTranscriptSummaryMessage(message)
  );

  return {
    summary,
    rawMessages,
    visibleMessages: summary
      ? [
          createTranscriptSummaryMessage(
            summary,
            normalizedCompaction?.compactedAt || extractedSummary?.createdAt
          ),
          ...rawMessages,
        ]
      : rawMessages,
  };
}

export function getArtifactTranscriptCompaction(
  artifact?: WorkflowStudioArtifact | null
): WorkflowTranscriptCompaction | undefined {
  return normalizeTranscriptCompaction(artifact?.transcriptCompaction);
}

export function estimateVisibleTranscriptTokens(input: {
  messages: WorkflowStudioMessage[];
  compaction?: WorkflowTranscriptCompaction | null;
  additionalText?: string;
}): number {
  const { visibleMessages } = getVisibleTranscriptState(input);
  return (
    estimateMessagesTokens(visibleMessages) +
    estimateTextTokens(input.additionalText) +
    256
  );
}

export function buildTranscriptCompactionPlan(input: {
  messages: WorkflowStudioMessage[];
  compaction?: WorkflowTranscriptCompaction | null;
  additionalText?: string;
  triggerTokens?: number;
  recentTokens?: number;
}): WorkflowTranscriptCompactionPlan | null {
  const triggerTokens =
    input.triggerTokens ?? WORKFLOW_TRANSCRIPT_TRIGGER_TOKENS;
  const recentTokens = input.recentTokens ?? WORKFLOW_TRANSCRIPT_RECENT_TOKENS;
  const { summary, rawMessages, visibleMessages } = getVisibleTranscriptState(
    input
  );
  const estimatedTokensBefore =
    estimateMessagesTokens(visibleMessages) + estimateTextTokens(input.additionalText);

  if (estimatedTokensBefore <= triggerTokens) {
    return null;
  }

  if (rawMessages.length <= 1) {
    return null;
  }

  const recentMessages: WorkflowStudioMessage[] = [];
  let recentTokensUsed = 0;

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index];
    const nextTokens = estimateMessageTokens(message);

    if (
      recentMessages.length < 2 ||
      recentTokensUsed + nextTokens <= recentTokens
    ) {
      recentMessages.unshift(message);
      recentTokensUsed += nextTokens;
      continue;
    }

    break;
  }

  if (recentMessages.length >= rawMessages.length) {
    return null;
  }

  return {
    existingSummary: summary,
    messagesToArchive: rawMessages.slice(0, rawMessages.length - recentMessages.length),
    recentMessages,
    estimatedTokensBefore,
  };
}

export function formatMessagesForSummaryPrompt(
  messages: WorkflowStudioMessage[]
): string {
  return messages
    .map(formatMessageForCompactionSummary)
    .filter(Boolean)
    .join("\n\n");
}

export function chunkMessagesForSummary(
  messages: WorkflowStudioMessage[],
  maxChunkTokens = WORKFLOW_TRANSCRIPT_SUMMARY_CHUNK_TOKENS
): WorkflowStudioMessage[][] {
  const chunks: WorkflowStudioMessage[][] = [];
  let currentChunk: WorkflowStudioMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const nextTokens = estimateMessageTokens(message);

    if (currentChunk.length > 0 && currentTokens + nextTokens > maxChunkTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += nextTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function buildFallbackTranscriptSummary(input: {
  previousSummary?: string;
  messages: WorkflowStudioMessage[];
}): string {
  const previousSummary = clampText(input.previousSummary || "", 1_800);
  const highlights = input.messages
    .map((message) => {
      const formatted = formatMessageForCompactionSummary(message);
      if (!formatted) {
        return "";
      }

      const normalized = formatted.replace(/\s+/g, " ").trim();
      return clampText(normalized, 220);
    })
    .filter(Boolean);
  const recentHighlights = Array.from(new Set(highlights)).slice(-10);

  return [
    previousSummary ? `Earlier summary:\n${previousSummary}` : "",
    recentHighlights.length > 0
      ? `Archived conversation highlights:\n${recentHighlights
          .map((line) => `- ${line}`)
          .join("\n")}`
      : "Earlier conversation was compacted to stay within the transcript budget.",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, FALLBACK_SUMMARY_MAX_CHARS);
}

export function applyTranscriptCompaction(input: {
  messages: WorkflowStudioMessage[];
  compaction?: WorkflowTranscriptCompaction | null;
  summary: string;
  messagesToArchive: WorkflowStudioMessage[];
  recentMessages: WorkflowStudioMessage[];
  compactedAt?: string;
}): {
  messages: WorkflowStudioMessage[];
  transcriptCompaction: WorkflowTranscriptCompaction;
} {
  const normalizedCompaction = normalizeTranscriptCompaction(input.compaction);
  const compactedAt = input.compactedAt || new Date().toISOString();
  const transcriptCompaction: WorkflowTranscriptCompaction = {
    version: WORKFLOW_TRANSCRIPT_COMPACTION_VERSION,
    summary: input.summary.trim(),
    compactedAt,
    archivedMessages: [
      ...(normalizedCompaction?.archivedMessages || []),
      ...input.messagesToArchive,
    ],
  };

  return {
    messages: [
      createTranscriptSummaryMessage(transcriptCompaction.summary, compactedAt),
      ...input.recentMessages,
    ],
    transcriptCompaction,
  };
}

export function stripArchivedMessagesFromCompaction(
  artifact?: WorkflowStudioArtifact | null
): WorkflowStudioArtifact | null | undefined {
  if (!artifact?.transcriptCompaction) {
    return artifact;
  }

  const normalizedCompaction = normalizeTranscriptCompaction(
    artifact.transcriptCompaction
  );

  if (!normalizedCompaction) {
    return {
      ...artifact,
      transcriptCompaction: undefined,
    };
  }

  return {
    ...artifact,
    transcriptCompaction: {
      ...normalizedCompaction,
      archivedMessages: [],
    },
  };
}

export function createTranscriptTooLargeError(
  messageEstimate: number,
  singleMessage = messageEstimate > WORKFLOW_TRANSCRIPT_MAX_PENDING_MESSAGE_TOKENS
): Error {
  return new Error(
    singleMessage
      ? "This single message is too large for Workflow Studio to compact safely. Split it into smaller requests and try again."
      : "Workflow Studio could not reduce the transcript enough to stay within the model context budget. Shorten the latest request and try again."
  );
}

export function isWorkflowPromptTooLongError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";

  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => pattern.test(message));
}
