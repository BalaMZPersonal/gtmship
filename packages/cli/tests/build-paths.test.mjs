import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnrichedEnv,
  resolveToolPathCandidates,
} from "../dist/commands/build.js";

test("resolveToolPathCandidates includes Homebrew Cloud SDK locations", () => {
  const paths = resolveToolPathCandidates({
    HOME: "/Users/tester",
    HOMEBREW_PREFIX: "/custom/homebrew",
  });

  assert.ok(paths.includes("/custom/homebrew/bin"));
  assert.ok(paths.includes("/custom/homebrew/share/google-cloud-sdk/bin"));
  assert.ok(paths.includes("/opt/homebrew/share/google-cloud-sdk/bin"));
  assert.ok(paths.includes("/usr/local/share/google-cloud-sdk/bin"));
  assert.ok(paths.includes("/home/linuxbrew/.linuxbrew/share/google-cloud-sdk/bin"));
  assert.ok(paths.includes("/Users/tester/google-cloud-sdk/bin"));
});

test("buildEnrichedEnv appends missing tool paths without duplicating PATH entries", () => {
  const env = buildEnrichedEnv({
    HOME: "/Users/tester",
    HOMEBREW_PREFIX: "/custom/homebrew",
    PATH: "/usr/bin:/custom/homebrew/bin",
  });
  const pathEntries = (env.PATH || "").split(":");

  assert.equal(pathEntries.filter((entry) => entry === "/custom/homebrew/bin").length, 1);
  assert.ok(pathEntries.includes("/custom/homebrew/share/google-cloud-sdk/bin"));
  assert.ok(pathEntries.includes("/usr/local/google-cloud-sdk/bin"));
});
