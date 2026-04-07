import { describe, expect, it } from "vitest";
import { firstDisplayValue, formatDisplayValue } from "./display-value";

describe("display value helpers", () => {
  it("stringifies plain objects for safe rendering", () => {
    expect(formatDisplayValue({ every: "5 minutes" })).toBe(
      '{"every":"5 minutes"}'
    );
  });

  it("returns the first renderable value", () => {
    expect(firstDisplayValue("", null, { every: "5 minutes" }, "fallback")).toBe(
      '{"every":"5 minutes"}'
    );
  });
});
