import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalWorkspaceOptions } from "@pulumi/pulumi/automation/index.js";

export interface PulumiWorkspacePaths {
  projectRoot: string;
  stateRoot: string;
  workspaceDir: string;
  backendDir: string;
}

export function resolvePulumiWorkspacePaths(
  projectRoot = process.cwd(),
): PulumiWorkspacePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, ".gtmship", "pulumi");

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    workspaceDir: join(stateRoot, "workspace"),
    backendDir: join(stateRoot, "backend"),
  };
}

export function resolvePulumiBackendUrl(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitBackendUrl = env.PULUMI_BACKEND_URL?.trim();
  if (explicitBackendUrl) {
    return explicitBackendUrl;
  }

  const paths = resolvePulumiWorkspacePaths(projectRoot);
  return pathToFileURL(paths.backendDir).href;
}

export function buildPulumiWorkspaceOptions(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): LocalWorkspaceOptions {
  const paths = resolvePulumiWorkspacePaths(projectRoot);
  mkdirSync(paths.workspaceDir, { recursive: true });

  if (!env.PULUMI_BACKEND_URL?.trim()) {
    mkdirSync(paths.backendDir, { recursive: true });
  }

  return {
    workDir: paths.workspaceDir,
    envVars: {
      ...(env.PULUMI_BACKEND_URL?.trim()
        ? { PULUMI_BACKEND_URL: env.PULUMI_BACKEND_URL.trim() }
        : { PULUMI_BACKEND_URL: resolvePulumiBackendUrl(projectRoot, env) }),
      ...(env.PULUMI_CONFIG_PASSPHRASE_FILE?.trim()
        ? { PULUMI_CONFIG_PASSPHRASE_FILE: env.PULUMI_CONFIG_PASSPHRASE_FILE.trim() }
        : { PULUMI_CONFIG_PASSPHRASE: env.PULUMI_CONFIG_PASSPHRASE ?? "" }),
    },
  };
}
