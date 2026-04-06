#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const supportedAssets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
];

function parseArgs(argv) {
  const args = new Map();

  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      continue;
    }
    args.set(key.slice(2), value);
  }

  const assets = Object.fromEntries(
    supportedAssets.map((asset) => [
      asset,
      {
        url: args.get(`${asset}-url`) || "",
        sha256: args.get(`${asset}-sha256`) || "",
      },
    ])
  );

  return {
    owner: args.get("owner") || "gtmship",
    version: args.get("version"),
    assets,
    output:
      args.get("output") ||
      path.join(process.cwd(), "dist", "homebrew", "gtmship.rb"),
  };
}

const options = parseArgs(process.argv);
const missingAssets = supportedAssets.filter((asset) => {
  const current = options.assets[asset];
  return !current.url || !current.sha256;
});

if (!options.version || missingAssets.length > 0) {
  console.error(
    `Usage: node scripts/render-homebrew-formula.mjs --version <v> \\
  --darwin-arm64-url <url> --darwin-arm64-sha256 <sha> \\
  --darwin-x64-url <url> --darwin-x64-sha256 <sha> \\
  --linux-arm64-url <url> --linux-arm64-sha256 <sha> \\
  --linux-x64-url <url> --linux-x64-sha256 <sha> \\
  [--owner <github-owner>] [--output <file>]`
  );
  if (missingAssets.length > 0) {
    console.error(`Missing asset metadata for: ${missingAssets.join(", ")}`);
  }
  process.exit(1);
}

const templatePath = path.join(
  process.cwd(),
  "packaging",
  "homebrew",
  "gtmship.rb.template"
);

const template = readFileSync(templatePath, "utf8");
const formula = template
  .replaceAll("%OWNER%", options.owner)
  .replaceAll("%VERSION%", options.version)
  .replaceAll("%DARWIN_ARM64_URL%", options.assets["darwin-arm64"].url)
  .replaceAll("%DARWIN_ARM64_SHA256%", options.assets["darwin-arm64"].sha256)
  .replaceAll("%DARWIN_X64_URL%", options.assets["darwin-x64"].url)
  .replaceAll("%DARWIN_X64_SHA256%", options.assets["darwin-x64"].sha256)
  .replaceAll("%LINUX_ARM64_URL%", options.assets["linux-arm64"].url)
  .replaceAll("%LINUX_ARM64_SHA256%", options.assets["linux-arm64"].sha256)
  .replaceAll("%LINUX_X64_URL%", options.assets["linux-x64"].url)
  .replaceAll("%LINUX_X64_SHA256%", options.assets["linux-x64"].sha256);

mkdirSync(path.dirname(options.output), { recursive: true });
writeFileSync(options.output, formula, "utf8");
console.log(`Wrote ${options.output}`);
