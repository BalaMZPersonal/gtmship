import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowProjectDeploymentDefaults } from "./types";
import { getSetting } from "./auth-service";
import { resolveProjectRoot } from "./project-root";

interface RawProjectConfig {
  deploy?: {
    provider?: string;
    region?: string;
    gcpProject?: string;
    gcp_project?: string;
  };
}

interface DashboardDeploymentSettings {
  provider?: WorkflowProjectDeploymentDefaults["provider"];
  awsRegion?: string;
  gcpRegion?: string;
  gcpProject?: string;
}

function normalizeProvider(
  value?: string | null
): WorkflowProjectDeploymentDefaults["provider"] {
  return value === "aws" || value === "gcp" ? value : undefined;
}

function normalizeString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDeploymentDefaults(
  value: RawProjectConfig | null | undefined
): WorkflowProjectDeploymentDefaults {
  const deploy = value?.deploy;
  if (!deploy) {
    return {};
  }

  return {
    provider: normalizeProvider(deploy.provider),
    region: normalizeString(deploy.region),
    gcpProject:
      normalizeString(deploy.gcpProject) ||
      normalizeString(deploy.gcp_project),
  };
}

async function loadDashboardDeploymentSettings(): Promise<DashboardDeploymentSettings> {
  const [provider, awsRegion, gcpRegion, gcpProject] = await Promise.all([
    getSetting("cloud_provider"),
    getSetting("aws_region"),
    getSetting("gcp_region"),
    getSetting("gcp_project_id"),
  ]);

  return {
    provider: normalizeProvider(provider),
    awsRegion: normalizeString(awsRegion),
    gcpRegion: normalizeString(gcpRegion),
    gcpProject: normalizeString(gcpProject),
  };
}

export async function loadProjectDeploymentDefaults(
  projectRootOverride?: string
): Promise<WorkflowProjectDeploymentDefaults> {
  const [dashboardDefaults, projectRoot] = await Promise.all([
    loadDashboardDeploymentSettings(),
    projectRootOverride
      ? Promise.resolve(projectRootOverride)
      : resolveProjectRoot().then((resolution) => resolution.projectRoot),
  ]);

  let projectDefaults: WorkflowProjectDeploymentDefaults = {};

  if (projectRoot) {
    const configPath = path.join(projectRoot, "gtmship.config.yaml");

    try {
      const raw = parseYaml(
        await readFile(configPath, "utf8")
      ) as RawProjectConfig | null;
      projectDefaults = normalizeDeploymentDefaults(raw);
    } catch {
      projectDefaults = {};
    }
  }

  const provider = projectDefaults.provider || dashboardDefaults.provider;

  return {
    provider,
    region:
      projectDefaults.region ||
      (provider === "gcp"
        ? dashboardDefaults.gcpRegion
        : provider === "aws"
          ? dashboardDefaults.awsRegion
          : undefined),
    gcpProject: projectDefaults.gcpProject || dashboardDefaults.gcpProject,
  };
}
