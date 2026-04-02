export const AI_PROVIDERS = ["claude", "openai"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiModelOption {
  id: string;
  displayName: string;
  provider: AiProvider;
  createdAt: string | null;
}

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Claude",
  openai: "OpenAI",
};

export const AI_API_KEY_SETTING_KEYS: Record<AiProvider, string> = {
  claude: "anthropic_api_key",
  openai: "openai_api_key",
};

export const AI_MODEL_SETTING_KEYS: Record<AiProvider, string> = {
  claude: "anthropic_model",
  openai: "openai_model",
};

export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeAiProvider(value?: string | null): AiProvider {
  return value === "openai" ? "openai" : "claude";
}
