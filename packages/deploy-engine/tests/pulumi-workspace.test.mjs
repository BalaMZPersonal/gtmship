import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPulumiWorkspaceOptions,
  resolvePulumiBackendUrl,
  resolvePulumiWorkspacePaths,
} from "../dist/pulumi-workspace.js";

test("resolvePulumiWorkspacePaths stores state under the project .gtmship directory", () => {
  const projectRoot = "/tmp/gtmship-project";
  const paths = resolvePulumiWorkspacePaths(projectRoot);

  assert.equal(paths.projectRoot, path.resolve(projectRoot));
  assert.equal(paths.stateRoot, path.join(path.resolve(projectRoot), ".gtmship", "pulumi"));
  assert.equal(paths.workspaceDir, path.join(paths.stateRoot, "workspace"));
  assert.equal(paths.backendDir, path.join(paths.stateRoot, "backend"));
});

test("resolvePulumiBackendUrl defaults to a local file backend", () => {
  const backendUrl = resolvePulumiBackendUrl("/tmp/gtmship-project", {});
  assert.equal(backendUrl, "file:///tmp/gtmship-project/.gtmship/pulumi/backend");
});

test("buildPulumiWorkspaceOptions respects an explicit backend override", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "gtmship-pulumi-"));
  const options = buildPulumiWorkspaceOptions(tempRoot, {
    PULUMI_BACKEND_URL: "s3://custom-backend",
    PULUMI_CONFIG_PASSPHRASE_FILE: "/tmp/pulumi-passphrase.txt",
  });

  assert.equal(options.workDir, path.join(tempRoot, ".gtmship", "pulumi", "workspace"));
  assert.deepEqual(options.envVars, {
    PULUMI_BACKEND_URL: "s3://custom-backend",
    PULUMI_CONFIG_PASSPHRASE_FILE: "/tmp/pulumi-passphrase.txt",
  });
});

test("buildPulumiWorkspaceOptions defaults to an empty passphrase with local backend", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "gtmship-pulumi-"));
  const options = buildPulumiWorkspaceOptions(tempRoot, {});

  assert.equal(options.workDir, path.join(tempRoot, ".gtmship", "pulumi", "workspace"));
  assert.equal(
    options.envVars?.PULUMI_BACKEND_URL,
    `file://${path.join(tempRoot, ".gtmship", "pulumi", "backend")}`,
  );
  assert.equal(options.envVars?.PULUMI_CONFIG_PASSPHRASE, "");
});
