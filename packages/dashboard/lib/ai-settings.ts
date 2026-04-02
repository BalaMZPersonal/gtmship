import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  AI_API_KEY_SETTING_KEYS,
  AI_DEFAULT_MODELS,
  AI_MODEL_SETTING_KEYS,
  AI_PROVIDER_LABELS,
  normalizeAiProvider,
  type AiModelOption,
  type AiProvider,
} from "@/lib/ai-config";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";

export async function getAuthSetting(key: string): Promise<string | null> {
  try {
    const response = await fetch(`${AUTH_URL}/settings/${key}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { value?: string };
    return data.value ?? null;
  } catch {
    return null;
  }
}

export async function resolveAiConfiguration() {
  const provider = normalizeAiProvider(await getAuthSetting("ai_provider"));
  const apiKeySettingKey = AI_API_KEY_SETTING_KEYS[provider];
  const modelSettingKey = AI_MODEL_SETTING_KEYS[provider];
  const apiKey = (await getAuthSetting(apiKeySettingKey))?.trim();

  if (!apiKey) {
    throw new Error(
      `${AI_PROVIDER_LABELS[provider]} API key not configured. Go to Settings to add it.`
    );
  }

  const configuredModel = (await getAuthSetting(modelSettingKey))?.trim();

  return {
    provider,
    apiKey,
    modelId: configuredModel || AI_DEFAULT_MODELS[provider],
  };
}

export async function createConfiguredLanguageModel(): Promise<LanguageModel> {
  const config = await resolveAiConfiguration();

  if (config.provider === "claude") {
    return createAnthropic({ apiKey: config.apiKey })(config.modelId);
  }

  return createOpenAI({ apiKey: config.apiKey })(config.modelId);
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

  const idMatch = id.toLowerCase().includes(query);
  const displayMatch = displayName.toLowerCase().includes(query);

  return idMatch || displayMatch;
}

function formatOpenAiDisplayName(id: string): string {
  return id;
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

async function extractProviderError(response: Response, provider: AiProvider) {
  const fallback = `${AI_PROVIDER_LABELS[provider]} model lookup failed with ${response.status}.`;
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
      return `${AI_PROVIDER_LABELS[provider]} model lookup failed: ${data.error}`;
    }

    if (
      data.error &&
      typeof data.error === "object" &&
      typeof data.error.message === "string" &&
      data.error.message
    ) {
      return `${AI_PROVIDER_LABELS[provider]} model lookup failed: ${data.error.message}`;
    }

    if (typeof data.message === "string" && data.message) {
      return `${AI_PROVIDER_LABELS[provider]} model lookup failed: ${data.message}`;
    }
  } catch {
    // Ignore malformed JSON and fall back to a trimmed text message when possible.
  }

  const trimmed = text.trim();
  return trimmed
    ? `${AI_PROVIDER_LABELS[provider]} model lookup failed: ${trimmed}`
    : fallback;
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

async function fetchOpenAiModels(
  apiKey: string,
  query: string
): Promise<AiModelOption[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    cache: "no-store",
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

      const displayName = formatOpenAiDisplayName(id);
      if (!matchesModelQuery(id, displayName, query)) {
        return null;
      }

      return {
        id,
        displayName,
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
    cache: "no-store",
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
  apiKey?: string | null;
  query?: string | null;
}): Promise<AiModelOption[]> {
  const provider = normalizeAiProvider(input.provider);
  const apiKey =
    input.apiKey?.trim() ||
    (await getAuthSetting(AI_API_KEY_SETTING_KEYS[provider]))?.trim();

  if (!apiKey) {
    throw new Error(
      `Add a ${AI_PROVIDER_LABELS[provider]} API key to load live models.`
    );
  }

  const query = normalizeQuery(input.query);

  if (provider === "claude") {
    return fetchAnthropicModels(apiKey, query);
  }

  return fetchOpenAiModels(apiKey, query);
}
