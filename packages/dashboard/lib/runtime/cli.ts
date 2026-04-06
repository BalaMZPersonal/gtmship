import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

export interface CliInvocation {
  command: string;
  baseArgs: string[];
}

function findMonorepoRoot(start: string): string {
  let dir = start;
  for (let index = 0; index < 10; index += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return start;
}

function findCliBinaryOnPath(): string | null {
  const result = spawnSync("which", ["gtmship"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout.trim();
  return output || null;
}

export function resolveCliInvocation(): CliInvocation {
  const cliBinary = process.env.GTMSHIP_CLI_BIN?.trim();
  if (cliBinary) {
    return {
      command: cliBinary,
      baseArgs: [],
    };
  }

  const cliEntry = process.env.GTMSHIP_CLI_ENTRY?.trim();
  if (cliEntry) {
    return {
      command: process.execPath,
      baseArgs: [cliEntry],
    };
  }

  const binaryOnPath = findCliBinaryOnPath();
  if (binaryOnPath) {
    return {
      command: binaryOnPath,
      baseArgs: [],
    };
  }

  const monorepoRoot = findMonorepoRoot(process.cwd());
  const monorepoCliEntry = resolvePath(
    monorepoRoot,
    "packages/cli/dist/index.js"
  );

  if (!existsSync(monorepoCliEntry)) {
    throw new Error(
      "Cannot find the GTMShip CLI entrypoint. Build the CLI package first or set GTMSHIP_CLI_ENTRY."
    );
  }

  return {
    command: process.execPath,
    baseArgs: [monorepoCliEntry],
  };
}

export function renderCliCommand(args: string[]): string {
  const invocation = resolveCliInvocation();
  return [invocation.command, ...invocation.baseArgs, ...args].join(" ");
}
