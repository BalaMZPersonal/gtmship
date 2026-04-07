import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpdateStatus,
  compareVersions,
  normalizeUpdateManifest,
} from "./updates.js";

test("compareVersions sorts semver values numerically", () => {
  assert.equal(compareVersions("0.1.10", "0.1.2") > 0, true);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.9", "1.0.0") < 0, true);
});

test("normalizeUpdateManifest applies defaults and rejects invalid payloads", () => {
  assert.equal(normalizeUpdateManifest(null), null);

  assert.deepEqual(
    normalizeUpdateManifest({
      version: "0.1.6",
      notesUrl: "https://example.com/releases/v0.1.6",
    }),
    {
      version: "0.1.6",
      tag: null,
      releasedAt: null,
      notesUrl: "https://example.com/releases/v0.1.6",
      severity: "info",
      message: null,
      minimumSupportedVersion: null,
      recommendedCommand:
        "brew update && brew upgrade BalaMZPersonal/tap/gtmship",
    }
  );
});

test("buildUpdateStatus distinguishes update and restart-required states", () => {
  const updateAvailable = buildUpdateStatus({
    installMethod: "homebrew",
    runningVersion: "0.1.5",
    installedVersion: "0.1.5",
    manifest: {
      version: "0.1.6",
      tag: "v0.1.6",
      releasedAt: "2026-04-07T12:00:00.000Z",
      notesUrl: "https://example.com/releases/v0.1.6",
      severity: "warning",
      message: "GTMShip 0.1.6 is available.",
      minimumSupportedVersion: null,
      recommendedCommand:
        "brew update && brew upgrade BalaMZPersonal/tap/gtmship",
    },
    checkedAt: "2026-04-07T12:10:00.000Z",
    stale: false,
    snoozedUntil: null,
  });

  assert.equal(updateAvailable.updateAvailable, true);
  assert.equal(updateAvailable.restartRequired, false);
  assert.equal(
    updateAvailable.recommendedCommand,
    "brew update && brew upgrade BalaMZPersonal/tap/gtmship"
  );

  const restartRequired = buildUpdateStatus({
    installMethod: "homebrew",
    runningVersion: "0.1.5",
    installedVersion: "0.1.6",
    manifest: {
      version: "0.1.6",
      tag: "v0.1.6",
      releasedAt: "2026-04-07T12:00:00.000Z",
      notesUrl: "https://example.com/releases/v0.1.6",
      severity: "info",
      message: "GTMShip 0.1.6 is available.",
      minimumSupportedVersion: null,
      recommendedCommand:
        "brew update && brew upgrade BalaMZPersonal/tap/gtmship",
    },
    checkedAt: "2026-04-07T12:10:00.000Z",
    stale: false,
    snoozedUntil: null,
  });

  assert.equal(restartRequired.updateAvailable, false);
  assert.equal(restartRequired.restartRequired, true);
  assert.equal(restartRequired.recommendedCommand, "gtmship restart");
  assert.match(restartRequired.message || "", /gtmship restart/i);
});
