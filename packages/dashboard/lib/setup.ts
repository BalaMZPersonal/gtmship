export const SETUP_STEP_IDS = [
  "ai",
  "cloud",
  "secret_storage",
  "workspace",
  "oauth_apps",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepStatus =
  | "complete"
  | "incomplete"
  | "skipped"
  | "blocked";
export type SetupOverallStatus = "complete" | "incomplete";

export interface SetupStepPreference {
  skipped?: boolean;
  choice?: string;
}

export interface SetupPreferences {
  version: 1;
  dismissedAt?: string | null;
  steps?: Partial<Record<SetupStepId, SetupStepPreference>>;
}

export interface SetupStepRecord {
  id: SetupStepId;
  title: string;
  optional: boolean;
  status: SetupStepStatus;
  summary: string;
  missing: string[];
  blockedBy: string[];
}

export interface SetupStatusResponse {
  overallStatus: SetupOverallStatus;
  dismissed: boolean;
  progress: {
    completed: number;
    total: number;
  };
  steps: SetupStepRecord[];
  preferences: SetupPreferences;
}

export function isSetupStepSatisfied(step: SetupStepRecord): boolean {
  return step.status === "complete" || step.status === "skipped";
}

export function getNextSetupStep(
  steps: SetupStepRecord[]
): SetupStepRecord | null {
  return (
    steps.find(
      (step) => !step.optional && !isSetupStepSatisfied(step)
    ) ||
    steps.find((step) => !isSetupStepSatisfied(step)) ||
    null
  );
}

export function formatSetupProgress(
  progress: SetupStatusResponse["progress"]
): string {
  return `${progress.completed}/${progress.total} steps ready`;
}

export function getSetupStepTone(status: SetupStepStatus): string {
  switch (status) {
    case "complete":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "skipped":
      return "border-zinc-700 bg-zinc-900 text-zinc-300";
    case "blocked":
      return "border-rose-500/30 bg-rose-500/10 text-rose-200";
    default:
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
}
