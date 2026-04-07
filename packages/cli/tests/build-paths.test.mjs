import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnrichedEnv,
  resolveGcpCredentialFile,
  resolveRequiredGcpServices,
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

test("buildEnrichedEnv mirrors GOOGLE_APPLICATION_CREDENTIALS into gcloud override env", () => {
  const env = buildEnrichedEnv({
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gtmship-service-account.json",
    PATH: "/usr/bin",
  });

  assert.equal(
    env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE,
    "/tmp/gtmship-service-account.json",
  );
  assert.equal(env.CLOUDSDK_CORE_DISABLE_PROMPTS, "1");
});

test("resolveGcpCredentialFile prefers explicit gcloud override", () => {
  const credentialFile = resolveGcpCredentialFile({
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/override.json",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
  });

  assert.equal(credentialFile, "/tmp/override.json");
});

test("resolveRequiredGcpServices includes base and optional APIs", () => {
  const services = resolveRequiredGcpServices([
    { cloudScheduler: true, secretManager: true },
    { database: true, storage: true },
  ]);

  assert.deepEqual(services, [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ]);
});
