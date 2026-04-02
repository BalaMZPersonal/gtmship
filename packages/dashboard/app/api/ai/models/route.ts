import { z } from "zod";
import { AI_PROVIDERS } from "@/lib/ai-config";
import { searchProviderModels } from "@/lib/ai-settings";

const requestSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().optional(),
  query: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const models = await searchProviderModels(body);

    return Response.json({ models });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load AI models.";

    return Response.json({ error: message }, { status: 400 });
  }
}
