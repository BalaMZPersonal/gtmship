export const AI_PROVIDERS = ["claude", "openai"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiModelOption {
  id: string;
  displayName: string;
  provider: AiProvider;
  createdAt: string | null;
}

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "claude" || value === "openai";
}

function normalizeProvider(value: unknown): AiProvider {
  return value === "openai" ? "openai" : "claude";
}

function normalizeQuery(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

function matchesModelQuery(
  id: string,
  displayName: string,
  query: string
): boolean {
  if (!query) {
    return true;
  }

  return (
    id.toLowerCase().includes(query) ||
    displayName.toLowerCase().includes(query)
  );
}

function sortModelOptions(options: AiModelOption[]): AiModelOption[] {
  return [...options].sort((left, right) => {
    const leftDate = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightDate = right.createdAt ? Date.parse(right.createdAt) : 0;

    if (leftDate !== rightDate) {
      return rightDate - leftDate;
    }

    return left.id.localeCompare(right.id);
  });
}

function isOpenAiChatModel(id: string): boolean {
  const normalized = id.toLowerCase();

  if (
    normalized.includes("embedding") ||
    normalized.includes("realtime") ||
    normalized.includes("whisper") ||
    normalized.includes("tts") ||
    normalized.includes("moderation") ||
    normalized.includes("dall") ||
    normalized.includes("image") ||
    normalized.includes("transcribe") ||
    normalized.includes("audio")
  ) {
    return false;
  }

  return (
    normalized.startsWith("gpt") ||
    normalized.startsWith("chatgpt") ||
    normalized.startsWith("codex") ||
    normalized.startsWith("computer-use") ||
    /^o[134](?:$|-)/.test(normalized)
  );
}

async function extractProviderError(
  response: Response,
  provider: AiProvider
): Promise<string> {
  const providerLabel = provider === "claude" ? "Claude" : "OpenAI";
  const fallback = `${providerLabel} model lookup failed with ${response.status}.`;
  const text = await response.text();

  if (!text) {
    return fallback;
  }

  try {
    const data = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };

    if (typeof data.error === "string" && data.error) {
      return `${providerLabel} model lookup failed: ${data.error}`;
    }

    if (
      data.error &&
      typeof data.error === "object" &&
      typeof data.error.message === "string" &&
      data.error.message
    ) {
      return `${providerLabel} model lookup failed: ${data.error.message}`;
    }

    if (typeof data.message === "string" && data.message) {
      return `${providerLabel} model lookup failed: ${data.message}`;
    }
  } catch {
    // Ignore malformed JSON and fall back to the raw response text.
  }

  const trimmed = text.trim();
  return trimmed
    ? `${providerLabel} model lookup failed: ${trimmed}`
    : fallback;
}

async function fetchOpenAiModels(
  apiKey: string,
  query: string
): Promise<AiModelOption[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(await extractProviderError(response, "openai"));
  }

  const data = (await response.json()) as {
    data?: Array<{
      id?: string;
      created?: number;
    }>;
  };

  const options = (data.data || [])
    .map((model) => {
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || !isOpenAiChatModel(id)) {
        return null;
      }

      if (!matchesModelQuery(id, id, query)) {
        return null;
      }

      return {
        id,
        displayName: id,
        provider: "openai" as const,
        createdAt:
          typeof model.created === "number"
            ? new Date(model.created * 1000).toISOString()
            : null,
      };
    })
    .filter(
      (
        option
      ): option is {
        id: string;
        displayName: string;
        provider: "openai";
        createdAt: string | null;
      } => option !== null
    );

  return sortModelOptions(options);
}

async function fetchAnthropicModels(
  apiKey: string,
  query: string
): Promise<AiModelOption[]> {
  const response = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!response.ok) {
    throw new Error(await extractProviderError(response, "claude"));
  }

  const data = (await response.json()) as {
    data?: Array<{
      id?: string;
      display_name?: string;
      created_at?: string;
    }>;
  };

  const options = (data.data || [])
    .map((model) => {
      const id = typeof model.id === "string" ? model.id.trim() : "";
      const displayName =
        typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.trim()
          : id;

      if (!id || !matchesModelQuery(id, displayName, query)) {
        return null;
      }

      return {
        id,
        displayName,
        provider: "claude" as const,
        createdAt:
          typeof model.created_at === "string" ? model.created_at : null,
      };
    })
    .filter(
      (
        option
      ): option is {
        id: string;
        displayName: string;
        provider: "claude";
        createdAt: string | null;
      } => option !== null
    );

  return sortModelOptions(options);
}

export async function searchProviderModels(input: {
  provider: AiProvider;
  apiKey: string;
  query?: string | null;
}): Promise<AiModelOption[]> {
  const provider = normalizeProvider(input.provider);
  const apiKey = input.apiKey.trim();

  if (!apiKey) {
    throw new Error(`Add a ${provider === "claude" ? "Claude" : "OpenAI"} API key to load live models.`);
  }

  const query = normalizeQuery(input.query);

  if (provider === "claude") {
    return fetchAnthropicModels(apiKey, query);
  }

  return fetchOpenAiModels(apiKey, query);
}
