import { describe, expect, it } from "vitest";
import {
  formatSetupProgress,
  getNextSetupStep,
  getSetupStepTone,
  isSetupStepSatisfied,
  type SetupStepRecord,
} from "@/lib/setup";

function createStep(
  overrides: Partial<SetupStepRecord>
): SetupStepRecord {
  return {
    id: "ai",
    title: "AI provider",
    optional: false,
    status: "incomplete",
    summary: "summary",
    missing: [],
    blockedBy: [],
    ...overrides,
  };
}

describe("setup helpers", () => {
  it("treats complete and skipped steps as satisfied", () => {
    expect(isSetupStepSatisfied(createStep({ status: "complete" }))).toBe(true);
    expect(isSetupStepSatisfied(createStep({ status: "skipped" }))).toBe(true);
    expect(isSetupStepSatisfied(createStep({ status: "incomplete" }))).toBe(false);
  });

  it("prefers the first unsatisfied required step as the next setup action", () => {
    const next = getNextSetupStep([
      createStep({ id: "workspace", optional: true, status: "incomplete" }),
      createStep({ id: "cloud", status: "blocked" }),
      createStep({ id: "oauth_apps", optional: true, status: "incomplete" }),
    ]);

    expect(next?.id).toBe("cloud");
  });

  it("formats progress and tones for display", () => {
    expect(formatSetupProgress({ completed: 2, total: 5 })).toBe("2/5 steps ready");
    expect(getSetupStepTone("blocked")).toContain("rose");
    expect(getSetupStepTone("complete")).toContain("emerald");
  });
});
