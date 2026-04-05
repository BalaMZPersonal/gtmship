import { Router } from "express";
import {
  isAiProvider,
  searchProviderModels,
} from "../services/ai-models.js";

export const aiRoutes: Router = Router();

aiRoutes.post("/models", async (req, res) => {
  const provider = req.body?.provider;
  const apiKey = req.body?.apiKey;
  const query = req.body?.query;

  if (!isAiProvider(provider)) {
    res.status(400).json({ error: "provider must be either \"claude\" or \"openai\"." });
    return;
  }

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "apiKey is required." });
    return;
  }

  try {
    const models = await searchProviderModels({
      provider,
      apiKey,
      query: typeof query === "string" ? query : undefined,
    });

    res.json({ models });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : "Unable to load AI models.",
    });
  }
});
