import { Router } from "express";
import {
  SETUP_STEP_IDS,
  getSetupStatus,
  updatePersistedSetupState,
  type PersistedSetupStepState,
  type SetupStepId,
} from "../services/setup.js";

export const setupRoutes: Router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

setupRoutes.get("/", async (_req, res) => {
  res.json(await getSetupStatus());
});

setupRoutes.put("/", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const dismissed =
    typeof body.dismissed === "boolean" ? body.dismissed : undefined;
  const stepsInput = isRecord(body.steps) ? body.steps : {};
  const steps: Partial<Record<SetupStepId, PersistedSetupStepState>> = {};

  for (const stepId of SETUP_STEP_IDS) {
    const value = stepsInput[stepId];
    if (!isRecord(value)) {
      continue;
    }

    steps[stepId] = {
      skipped:
        typeof value.skipped === "boolean" ? value.skipped : undefined,
      choice: typeof value.choice === "string" ? value.choice : undefined,
    };
  }

  await updatePersistedSetupState({
    dismissed,
    steps,
  });

  res.json(await getSetupStatus());
});
