import { Router } from "express";
import { prisma } from "../services/db.js";
import { encrypt, decrypt } from "../services/crypto.js";
import {
  getConnectionAuthStrategyStatus,
  normalizeConnectionAuthMode,
  setConnectionAuthMode,
  syncAllActiveConnectionsToSecretManagers,
  validateSecretManagerReadiness,
} from "../services/auth-strategy.js";
import { enforceAuthModeOnExistingDeployments } from "../services/workflow-deployment-auth.js";
import { SETUP_STATE_SETTING_KEY } from "../services/setup.js";

export const settingsRoutes: Router = Router();

const SENSITIVE_KEYS = ["anthropic_api_key", "openai_api_key", "aws_secret_access_key", "gcp_service_account_key"];

// Get all settings
settingsRoutes.get("/", async (_req, res) => {
  const settings = await prisma.setting.findMany({
    where: {
      key: {
        not: SETUP_STATE_SETTING_KEY,
      },
    },
  });
  const safe = settings.map((s) => ({
    key: s.key,
    value: SENSITIVE_KEYS.includes(s.key)
      ? `${decrypt(s.value).slice(0, 8)}••••••••`
      : s.value,
  }));
  res.json(safe);
});

settingsRoutes.get("/auth-strategy", async (_req, res) => {
  const status = await getConnectionAuthStrategyStatus();
  res.json(status);
});

settingsRoutes.put("/auth-strategy", async (req, res) => {
  if (req.body?.mode !== "proxy" && req.body?.mode !== "secret_manager") {
    res.status(400).json({
      error: "mode must be either \"proxy\" or \"secret_manager\".",
    });
    return;
  }

  const mode = normalizeConnectionAuthMode(req.body.mode);

  try {
    if (mode === "secret_manager") {
      await validateSecretManagerReadiness();
    }

    await setConnectionAuthMode(mode);

    const connectionBackfill =
      mode === "secret_manager"
        ? await syncAllActiveConnectionsToSecretManagers()
        : {
            activeConnections: 0,
            syncedReplicas: 0,
            errorReplicas: 0,
          };
    const deploymentBackfill = await enforceAuthModeOnExistingDeployments(mode);
    const strategy = await getConnectionAuthStrategyStatus();

    res.json({
      ...strategy,
      updated: true,
      backfill: {
        connections: connectionBackfill,
        deployments: deploymentBackfill,
      },
    });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to update connection auth strategy.",
    });
  }
});

// Get a specific setting
settingsRoutes.get("/:key", async (req, res) => {
  const setting = await prisma.setting.findUnique({
    where: { key: req.params.key },
  });
  if (!setting) {
    res.status(404).json({ error: "Setting not found" });
    return;
  }
  res.json({
    key: setting.key,
    value: SENSITIVE_KEYS.includes(setting.key)
      ? decrypt(setting.value)
      : setting.value,
  });
});

// Set a setting
settingsRoutes.put("/:key", async (req, res) => {
  const { value } = req.body;
  const encrypted = SENSITIVE_KEYS.includes(req.params.key)
    ? encrypt(value)
    : value;

  const setting = await prisma.setting.upsert({
    where: { key: req.params.key },
    update: { value: encrypted },
    create: { key: req.params.key, value: encrypted },
  });

  res.json({ key: setting.key, updated: true });
});

// Delete a setting
settingsRoutes.delete("/:key", async (req, res) => {
  await prisma.setting.delete({ where: { key: req.params.key } });
  res.status(204).end();
});
