import { Router } from "express";
import { prisma } from "../services/db.js";
import { encrypt, decrypt } from "../services/crypto.js";

export const settingsRoutes: Router = Router();

const SENSITIVE_KEYS = ["anthropic_api_key", "openai_api_key", "aws_secret_access_key", "gcp_service_account_key"];

// Get all settings
settingsRoutes.get("/", async (_req, res) => {
  const settings = await prisma.setting.findMany();
  const safe = settings.map((s) => ({
    key: s.key,
    value: SENSITIVE_KEYS.includes(s.key)
      ? `${decrypt(s.value).slice(0, 8)}••••••••`
      : s.value,
  }));
  res.json(safe);
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
