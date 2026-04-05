import type {
  WorkflowAiGenerateInput,
  WorkflowAiGenerateResult,
  WorkflowAiProviderSlug,
  WorkflowAiResponseFormat,
} from "./types.js";

function stringifyInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildUserPrompt(input: WorkflowAiGenerateInput): string {
  const sections: string[] = [];

  if (input.prompt?.trim()) {
    sections.push(input.prompt.trim());
  }

  const serializedInput = stringifyInput(input.input).trim();
  if (serializedInput) {
    sections.push(
      sections.length > 0
        ? ["Input data:", serializedInput].join("\n")
        : serializedInput
    );
  }

  if (sections.length === 0) {
    throw new Error("ctx.ai.generate requires prompt or input.");
  }

  return sections.join("\n\n");
}

function buildSystemPrompt(input: WorkflowAiGenerateInput): string | undefined {
  const instructions: string[] = [];

  if (input.system?.trim()) {
    instructions.push(input.system.trim());
  }

  if (input.responseFormat === "json") {
    instructions.push("Return only valid JSON. Do not include markdown fences.");
  }

  return instructions.length > 0 ? instructions.join("\n\n") : undefined;
}

export function isWorkflowAiProviderSlug(
  value: string
): value is WorkflowAiProviderSlug {
  return value === "openai" || value === "anthropic";
}

export function normalizeWorkflowAiResponseFormat(
  value?: WorkflowAiResponseFormat
): WorkflowAiResponseFormat {
  if (value === "json" || value === "raw") {
    return value;
  }

  return "text";
}

export function buildWorkflowAiRequest(input: WorkflowAiGenerateInput): {
  path: string;
  body: Record<string, unknown>;
} {
  const model = input.model.trim();
  if (!model) {
    throw new Error("ctx.ai.generate requires a model.");
  }

  const system = buildSystemPrompt(input);
  const prompt = buildUserPrompt(input);

  if (input.providerSlug === "anthropic") {
    return {
      path: "/v1/messages",
      body: {
        model,
        max_tokens: input.maxOutputTokens || 1024,
        ...(typeof input.temperature === "number"
          ? { temperature: input.temperature }
          : {}),
        ...(system ? { system } : {}),
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      },
    };
  }

  return {
    path: "/v1/chat/completions",
    body: {
      model,
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.maxOutputTokens === "number"
        ? { max_tokens: input.maxOutputTokens }
        : {}),
      messages: [
        ...(system
          ? [
              {
                role: "system",
                content: system,
              },
            ]
          : []),
        {
          role: "user",
          content: prompt,
        },
      ],
      ...(input.responseFormat === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    },
  };
}

function extractOpenAiText(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const choices = Array.isArray(record.choices)
    ? (record.choices as Array<Record<string, unknown>>)
    : [];
  const message =
    choices[0] &&
    typeof choices[0].message === "object" &&
    choices[0].message !== null
      ? (choices[0].message as Record<string, unknown>)
      : null;
  const content = message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry
          ? String((entry as { text?: unknown }).text || "")
          : ""
      )
      .join("")
      .trim();
  }

  return "";
}

function extractAnthropicText(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const content = Array.isArray(record.content)
    ? (record.content as Array<Record<string, unknown>>)
    : [];

  return content
    .map((entry) =>
      entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""
    )
    .join("")
    .trim();
}

function extractUsage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const usage = (payload as { usage?: unknown }).usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : null;
}

function extractStopReason(payload: unknown, providerSlug: WorkflowAiProviderSlug) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  if (providerSlug === "anthropic") {
    return typeof (payload as { stop_reason?: unknown }).stop_reason === "string"
      ? ((payload as { stop_reason?: string }).stop_reason as string)
      : null;
  }

  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices as Array<
        Record<string, unknown>
      >)
    : [];

  return typeof choices[0]?.finish_reason === "string"
    ? (choices[0].finish_reason as string)
    : null;
}

export function parseWorkflowAiResponse<TJson = unknown>(input: {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  status: number;
  responseFormat?: WorkflowAiResponseFormat;
  raw: unknown;
}): WorkflowAiGenerateResult<TJson> {
  const responseFormat = normalizeWorkflowAiResponseFormat(input.responseFormat);
  const text =
    input.providerSlug === "anthropic"
      ? extractAnthropicText(input.raw)
      : extractOpenAiText(input.raw);

  let json: TJson | null = null;
  if (responseFormat === "json") {
    try {
      json = JSON.parse(text) as TJson;
    } catch (error) {
      throw new Error(
        `AI response from ${input.providerSlug} was not valid JSON: ${
          error instanceof Error ? error.message : "unknown parse error"
        }`
      );
    }
  }

  return {
    providerSlug: input.providerSlug,
    model: input.model.trim(),
    status: input.status,
    text: text || null,
    json,
    raw: input.raw,
    usage: extractUsage(input.raw),
    stopReason: extractStopReason(input.raw, input.providerSlug),
  };
}
