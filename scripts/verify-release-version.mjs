#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const explicitVersionArg = process.argv.find((value) =>
  value.startsWith("--version=")
);
const versionArgIndex = process.argv.findIndex((value) => value === "--version");
const rawVersion = explicitVersionArg
  ? explicitVersionArg.slice("--version=".length)
  : versionArgIndex >= 0
    ? process.argv[versionArgIndex + 1]
    : undefined;
const expectedVersion = rawVersion?.replace(/^v/, "") || "";

if (!expectedVersion) {
  console.error(
    "Usage: node scripts/verify-release-version.mjs --version <version-or-tag>"
  );
  process.exit(1);
}

const versionFiles = [
  "packages/cli/package.json",
  "packages/auth-service/package.json",
  "packages/dashboard/package.json",
  "packages/deploy-engine/package.json",
  "packages/sdk/package.json",
];

const mismatches = versionFiles.flatMap((relativePath) => {
  const filePath = path.join(process.cwd(), relativePath);
  const pkg = JSON.parse(readFileSync(filePath, "utf8"));
  return pkg.version === expectedVersion
    ? []
    : [{ path: relativePath, version: pkg.version || "(missing)" }];
});

if (mismatches.length > 0) {
  console.error(
    `Release tag version ${expectedVersion} does not match package versions:`
  );
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch.path}: ${mismatch.version}`);
  }
  process.exit(1);
}

console.log(`Verified release package versions for ${expectedVersion}`);
