import type {
  ContextPressureEvent,
  WorkflowStudioMessage,
  WorkflowStudioToolInvocation,
} from "./types";
import { estimateMessagesTokens } from "./transcript-compaction";

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

export const COORDINATOR_TOKEN_BUDGET = 120_000;
export const GENERATION_TOKEN_BUDGET = 80_000;

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_TIER1_THRESHOLD = 0.7;
const DEFAULT_TIER2_THRESHOLD = 0.85;
const DEFAULT_TIER3_THRESHOLD = 0.95;
const DEFAULT_BASE_TOOL_RESULT_LIMIT = 15_000;
const DEFAULT_MIN_SCALE_FACTOR = 0.25;
const DEFAULT_TIER2_PRESERVE_RECENT = 6;
const DEFAULT_TIER2_MIN_CONTENT_LENGTH = 800;
const DEFAULT_TIER3_PRESERVE_TRAILING = 8;
const DEFAULT_TIER3_MAX_AI_EXCERPTS = 20;
const DEFAULT_TIER3_MAX_TOOL_EXCERPTS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextManagerOptions {
  tokenBudget: number;
  tier1Threshold?: number;
  tier2Threshold?: number;
  tier3Threshold?: number;
  baseToolResultLimit?: number;
  minScaleFactor?: number;
  tier2PreserveRecent?: number;
  tier2MinContentLength?: number;
  tier3PreserveTrailing?: number;
  tier3MaxAIExcerpts?: number;
  tier3MaxToolExcerpts?: number;
}

interface ResolvedOptions {
  tokenBudget: number;
  tier1Threshold: number;
  tier2Threshold: number;
  tier3Threshold: number;
  baseToolResultLimit: number;
  minScaleFactor: number;
  tier2PreserveRecent: number;
  tier2MinContentLength: number;
  tier3PreserveTrailing: number;
  tier3MaxAIExcerpts: number;
  tier3MaxToolExcerpts: number;
}

export interface ContextManageResult {
  messages: WorkflowStudioMessage[];
  pressure: ContextPressureEvent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function hasToolResults(message: WorkflowStudioMessage): boolean {
  return getToolInvocations(message).some(
    (inv) => inv.state === "result" && inv.result !== undefined
  );
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateMiddle(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  return `${text.slice(0, headChars)}\n[... truncated ...]\n${text.slice(-tailChars)}`;
}

function cloneInvocationWithTruncatedResult(
  inv: WorkflowStudioToolInvocation,
  headChars: number,
  tailChars: number
): WorkflowStudioToolInvocation {
  if (inv.result === undefined) return inv;

  const resultStr = stringifyResult(inv.result);
  if (resultStr.length <= headChars + tailChars) return inv;

  return {
    ...inv,
    result: truncateMiddle(resultStr, headChars, tailChars),
  };
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  private readonly opts: ResolvedOptions;
  private _currentToolResultLimit: number;

  constructor(options: ContextManagerOptions) {
    this.opts = {
      tokenBudget: options.tokenBudget,
      tier1Threshold: options.tier1Threshold ?? DEFAULT_TIER1_THRESHOLD,
      tier2Threshold: options.tier2Threshold ?? DEFAULT_TIER2_THRESHOLD,
      tier3Threshold: options.tier3Threshold ?? DEFAULT_TIER3_THRESHOLD,
      baseToolResultLimit: options.baseToolResultLimit ?? DEFAULT_BASE_TOOL_RESULT_LIMIT,
      minScaleFactor: options.minScaleFactor ?? DEFAULT_MIN_SCALE_FACTOR,
      tier2PreserveRecent: options.tier2PreserveRecent ?? DEFAULT_TIER2_PRESERVE_RECENT,
      tier2MinContentLength: options.tier2MinContentLength ?? DEFAULT_TIER2_MIN_CONTENT_LENGTH,
      tier3PreserveTrailing: options.tier3PreserveTrailing ?? DEFAULT_TIER3_PRESERVE_TRAILING,
      tier3MaxAIExcerpts: options.tier3MaxAIExcerpts ?? DEFAULT_TIER3_MAX_AI_EXCERPTS,
      tier3MaxToolExcerpts: options.tier3MaxToolExcerpts ?? DEFAULT_TIER3_MAX_TOOL_EXCERPTS,
    };
    this._currentToolResultLimit = this.opts.baseToolResultLimit;
  }

  /** Current character limit for tool results. Tools should respect this. */
  getToolResultLimit(): number {
    return this._currentToolResultLimit;
  }

  /**
   * Main entry point — call before every LLM invocation.
   * Returns (potentially compressed) messages and a silent pressure event.
   */
  manage(messages: WorkflowStudioMessage[]): ContextManageResult {
    const tokenEstimate = estimateMessagesTokens(messages);
    const ratio = tokenEstimate / this.opts.tokenBudget;

    // Reset tool result limit
    this._currentToolResultLimit = this.opts.baseToolResultLimit;

    let resultMessages = messages;
    let tier: 0 | 1 | 2 | 3 = 0;

    if (ratio >= this.opts.tier3Threshold) {
      // Apply all three tiers
      this.applyTier1(this.opts.tier2Threshold);
      resultMessages = this.applyTier2(resultMessages);
      resultMessages = this.applyTier3(resultMessages);
      tier = 3;
    } else if (ratio >= this.opts.tier2Threshold) {
      this.applyTier1(ratio);
      resultMessages = this.applyTier2(resultMessages);
      tier = 2;
    } else if (ratio >= this.opts.tier1Threshold) {
      this.applyTier1(ratio);
      tier = 1;
    }

    return {
      messages: resultMessages,
      pressure: {
        type: "context-pressure",
        tier,
        usageRatio: Math.round(ratio * 1000) / 1000,
        tokenEstimate,
        tokenBudget: this.opts.tokenBudget,
        toolResultLimit: this._currentToolResultLimit,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Tier 1: Adaptive Tool Result Truncation
  // -------------------------------------------------------------------------

  /**
   * Linearly scales `_currentToolResultLimit` from base → base * minScale
   * across the tier1–tier2 range. Non-destructive: no messages are modified.
   */
  private applyTier1(ratio: number): void {
    const { tier1Threshold, tier2Threshold, baseToolResultLimit, minScaleFactor } =
      this.opts;
    const range = tier2Threshold - tier1Threshold;
    const progress = Math.min(Math.max((ratio - tier1Threshold) / range, 0), 1);
    const scale = Math.max(1.0 - progress * (1.0 - minScaleFactor), minScaleFactor);

    this._currentToolResultLimit = Math.floor(baseToolResultLimit * scale);
  }

  // -------------------------------------------------------------------------
  // Tier 2: Compress Old Tool Results
  // -------------------------------------------------------------------------

  /**
   * Finds messages with tool results. Keeps the last N intact.
   * Older tool results exceeding minContentLength are head/tail truncated.
   * Returns a new array — input is never mutated.
   */
  private applyTier2(
    messages: WorkflowStudioMessage[],
    preserveRecent?: number
  ): WorkflowStudioMessage[] {
    const preserve = preserveRecent ?? this.opts.tier2PreserveRecent;
    const minLen = this.opts.tier2MinContentLength;

    // Find indices of messages that contain tool results
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (hasToolResults(messages[i])) {
        toolResultIndices.push(i);
      }
    }

    // Determine which indices to compress (all except the last `preserve`)
    const indicesToCompress = new Set(
      toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - preserve))
    );

    if (indicesToCompress.size === 0) return messages;

    return messages.map((message, idx) => {
      if (!indicesToCompress.has(idx)) return message;

      const invocations = getToolInvocations(message);
      const compressed = invocations.map((inv) =>
        inv.state === "result" &&
        inv.result !== undefined &&
        stringifyResult(inv.result).length > minLen
          ? cloneInvocationWithTruncatedResult(inv, 500, 300)
          : inv
      );

      // If nothing changed, return original message
      if (compressed.every((inv, i) => inv === invocations[i])) return message;

      // Build new message with compressed invocations
      const newMessage: WorkflowStudioMessage = { ...message };

      if (message.toolInvocations?.length) {
        newMessage.toolInvocations = compressed;
      }

      if (message.parts?.length) {
        let compIdx = 0;
        newMessage.parts = message.parts.map((part) => {
          if (part.type === "tool-invocation" && part.toolInvocation) {
            const replacement = compressed[compIdx++];
            return replacement !== part.toolInvocation
              ? { ...part, toolInvocation: replacement }
              : part;
          }
          return part;
        });
      }

      return newMessage;
    });
  }

  // -------------------------------------------------------------------------
  // Tier 3: Compact Conversation
  // -------------------------------------------------------------------------

  /**
   * Nuclear option: collapses the middle of the conversation into a single
   * system message. Preserves first 2 messages and last N messages.
   * Falls back to aggressive Tier 2 if conversation is too short.
   */
  private applyTier3(messages: WorkflowStudioMessage[]): WorkflowStudioMessage[] {
    const preserveTrailing = this.opts.tier3PreserveTrailing;
    const minMessagesForTier3 = 2 + preserveTrailing + 1; // head + tail + at least 1 middle

    if (messages.length <= minMessagesForTier3) {
      // Not enough middle to compact — apply aggressive Tier 2 instead
      return this.applyTier2(messages, Math.min(3, this.opts.tier2PreserveRecent));
    }

    const head = messages.slice(0, 2);
    const tail = messages.slice(-preserveTrailing);
    const middle = messages.slice(2, messages.length - preserveTrailing);

    const summaryContent = this.buildTier3Summary(middle);
    const summaryMessage: WorkflowStudioMessage = {
      id: `context-compaction-${Date.now()}`,
      role: "system",
      content: summaryContent,
      annotations: [{ type: "context-compaction-tier3" }],
    };

    return [...head, summaryMessage, ...tail];
  }

  /**
   * Builds a mechanical summary from the middle section of the conversation.
   * Extracts AI reasoning excerpts and tool result excerpts.
   */
  private buildTier3Summary(middle: WorkflowStudioMessage[]): string {
    const { tier3MaxAIExcerpts, tier3MaxToolExcerpts } = this.opts;

    const aiExcerpts: string[] = [];
    const toolExcerpts: string[] = [];

    for (const message of middle) {
      // Extract AI reasoning
      if (
        message.role === "assistant" &&
        aiExcerpts.length < tier3MaxAIExcerpts
      ) {
        const text =
          message.content?.trim() ||
          message.parts
            ?.filter(
              (p): p is { type: "text"; text: string } => p.type === "text"
            )
            .map((p) => p.text)
            .join("\n")
            .trim() ||
          "";
        if (text) {
          aiExcerpts.push(
            text.length > 500 ? `${text.slice(0, 500)}...` : text
          );
        }
      }

      // Extract tool results
      if (toolExcerpts.length < tier3MaxToolExcerpts) {
        for (const inv of getToolInvocations(message)) {
          if (
            inv.state === "result" &&
            inv.result !== undefined &&
            toolExcerpts.length < tier3MaxToolExcerpts
          ) {
            const resultStr = stringifyResult(inv.result);
            const excerpt =
              resultStr.length > 300
                ? `${resultStr.slice(0, 300)}...`
                : resultStr;
            toolExcerpts.push(`[${inv.toolName}] ${excerpt}`);
          }
        }
      }
    }

    const sections: string[] = [
      "[Context compacted to stay within token budget]",
    ];

    if (aiExcerpts.length > 0) {
      sections.push(
        "## Analysis & Reasoning",
        ...aiExcerpts.map((e, i) => `${i + 1}. ${e}`)
      );
    }

    if (toolExcerpts.length > 0) {
      sections.push(
        "## Tool Results",
        ...toolExcerpts.map((e, i) => `${i + 1}. ${e}`)
      );
    }

    sections.push(
      "",
      "Use identifiers and findings from the summary above in your continued analysis."
    );

    return sections.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Tool result truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate a tool result's string fields to fit within the given character limit.
 * Works generically on any object by truncating string values proportionally.
 */
export function truncateToolResult<T>(result: T, charLimit: number): T {
  if (result === null || result === undefined) return result;

  if (typeof result === "string") {
    return (
      result.length <= charLimit
        ? result
        : truncateMiddle(result, Math.floor(charLimit * 0.6), Math.floor(charLimit * 0.4))
    ) as T;
  }

  if (typeof result !== "object") return result;

  const serialized = JSON.stringify(result);
  if (serialized.length <= charLimit) return result;

  // For objects, truncate each string-valued field proportionally
  const obj = result as Record<string, unknown>;
  const stringKeys = Object.keys(obj).filter((k) => typeof obj[k] === "string");
  if (stringKeys.length === 0) return result;

  const perFieldLimit = Math.floor(charLimit / stringKeys.length);
  const truncated = { ...obj };

  for (const key of stringKeys) {
    const value = truncated[key] as string;
    if (value.length > perFieldLimit) {
      truncated[key] = truncateMiddle(
        value,
        Math.floor(perFieldLimit * 0.6),
        Math.floor(perFieldLimit * 0.4)
      );
    }
  }

  return truncated as T;
}
