#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = new Map();

  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      continue;
    }
    args.set(key.slice(2), value);
  }

  const owner = args.get("owner") || "BalaMZPersonal";
  const version = args.get("version") || "";
  const tag = args.get("tag") || (version ? `v${version}` : "");

  return {
    owner,
    version,
    tag,
    releasedAt: args.get("released-at") || new Date().toISOString(),
    notesUrl:
      args.get("notes-url") ||
      (tag ? `https://github.com/${owner}/gtmship/releases/tag/${tag}` : ""),
    severity: args.get("severity") || "info",
    message:
      args.get("message") ||
      (version ? `GTMShip ${version} is available.` : ""),
    minimumSupportedVersion: args.get("minimum-supported-version") || null,
    recommendedCommand:
      args.get("recommended-command") ||
      `brew update && brew upgrade ${owner}/tap/gtmship`,
    output:
      args.get("output") ||
      path.join(process.cwd(), "dist", "homebrew", "gtmship-update.json"),
  };
}

const options = parseArgs(process.argv);

if (!options.version || !options.tag || !options.notesUrl) {
  console.error(
    `Usage: node scripts/render-homebrew-update-manifest.mjs --version <v> --tag <tag> \\
  [--owner <github-owner>] [--released-at <iso>] [--notes-url <url>] \\
  [--severity <level>] [--message <text>] [--minimum-supported-version <v>] \\
  [--recommended-command <command>] [--output <file>]`
  );
  process.exit(1);
}

const manifest = {
  version: options.version,
  tag: options.tag,
  releasedAt: options.releasedAt,
  notesUrl: options.notesUrl,
  severity: options.severity,
  message: options.message,
  minimumSupportedVersion: options.minimumSupportedVersion,
  recommendedCommand: options.recommendedCommand,
};

mkdirSync(path.dirname(options.output), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${options.output}`);
