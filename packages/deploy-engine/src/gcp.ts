/**
 * GCP Deployment Engine — needs-based provisioning
 *
 * Only creates the resources the workflow actually requires:
 * - Service Account + IAM (always)
 * - Cloud Run Job OR Service (based on execution kind)
 * - Cloud Scheduler (for schedule triggers)
 * - Secret Manager IAM (for secret_manager auth mode)
 * - Cloud SQL + VPC (only when database is explicitly needed)
 * - Cloud Storage (only when artifact storage is needed)
 */

import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

import type { DeployStatus } from "./aws.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GcpResourceNeeds {
  /** Cloud Run Job (for scheduled/event workflows) vs Service (for webhook/long-running). */
  executionKind: "job" | "service";
  /** Whether a Cloud Scheduler job is needed (schedule trigger). */
  cloudScheduler?: boolean;
  /** Cron expression for Cloud Scheduler. */
  scheduleCron?: string;
  /** Timezone for Cloud Scheduler. */
  scheduleTimezone?: string;
  /** Whether the workflow uses secret_manager auth mode (grants Secret Manager IAM). */
  secretManager?: boolean;
  /** Whether a Cloud SQL database is needed. */
  database?: boolean;
  /** Whether a Cloud Storage bucket is needed. */
  storage?: boolean;
  /** Whether public (unauthenticated) ingress is needed (e.g., webhook triggers). */
  publicIngress?: boolean;
  /** Memory limit for the Cloud Run container (e.g., "512Mi", "1Gi"). */
  memory?: string;
  /** CPU limit for the Cloud Run container (e.g., "1", "2"). */
  cpu?: string;
}

export interface GcpConfig {
  region: string;
  projectName: string;
  gcpProject: string;
  /** What resources the workflow actually needs. */
  needs: GcpResourceNeeds;
  /** Optional DB password. A random one is generated if omitted. */
  dbPassword?: string;
  /** Optional path to container image or source archive. */
  serviceCodePath?: string;
  /** Runtime environment variables to inject into the Cloud Run container. */
  runtimeEnvVars?: Array<{ name: string; value: string }>;
}

export interface GcpDeployResult {
  serviceUrl: string;
  serviceId: string;
  cloudSqlEndpoint: string;
  gcsBucket: string;
  schedulerJobId: string;
  runtimeTarget: GcpRuntimeTarget;
}

export interface GcpRuntimeTarget {
  kind: "service" | "job";
  name: string;
  endpointUrl: string;
  schedulerJobId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PULUMI_PROJECT = "gtmship";
const DB_NAME = "gtmship";
const DB_USERNAME = "gtmship_admin";

const DEFAULT_MEMORY = "512Mi";
const DEFAULT_CPU = "1";

// ---------------------------------------------------------------------------
// Pulumi inline program
// ---------------------------------------------------------------------------

function createPulumiProgram(config: GcpConfig) {
  return async (): Promise<Record<string, pulumi.Output<string>>> => {
    const needs = config.needs;
    const outputs: Record<string, pulumi.Output<string>> = {};

    // -----------------------------------------------------------------------
    // Service Account + IAM (always created)
    // -----------------------------------------------------------------------

    const serviceAccount = new gcp.serviceaccount.Account(
      "gtmship-cloudrun-sa",
      {
        accountId: "gtmship-cloudrun",
        displayName: `GTMShip Cloud Run SA (${config.projectName})`,
      },
    );

    // Cloud Logging Writer (always)
    new gcp.projects.IAMMember("gtmship-sa-logging", {
      project: config.gcpProject,
      role: "roles/logging.logWriter",
      member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
    });

    // Secret Manager access (when auth mode is secret_manager)
    if (needs.secretManager) {
      new gcp.projects.IAMMember("gtmship-sa-secrets", {
        project: config.gcpProject,
        role: "roles/secretmanager.secretAccessor",
        member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
      });
    }

    // -----------------------------------------------------------------------
    // Artifact Registry — repo created by CLI (gcloud) during build step.
    // Grant the Cloud Run SA permission to pull images from it.
    // -----------------------------------------------------------------------

    new gcp.projects.IAMMember("gtmship-sa-artifact-reader", {
      project: config.gcpProject,
      role: "roles/artifactregistry.reader",
      member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
    });

    // -----------------------------------------------------------------------
    // Cloud SQL (only when database is needed)
    // -----------------------------------------------------------------------

    let sqlInstance: gcp.sql.DatabaseInstance | undefined;

    if (needs.database) {
      const network = new gcp.compute.Network("gtmship-network", {
        autoCreateSubnetworks: false,
        description: `GTMShip VPC for ${config.projectName}`,
      });

      new gcp.compute.Subnetwork("gtmship-subnet", {
        ipCidrRange: "10.0.0.0/24",
        region: config.region,
        network: network.id,
        privateIpGoogleAccess: true,
      });

      const router = new gcp.compute.Router("gtmship-router", {
        region: config.region,
        network: network.id,
      });

      new gcp.compute.RouterNat("gtmship-nat", {
        router: router.name,
        region: config.region,
        natIpAllocateOption: "AUTO_ONLY",
        sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
      });

      const privateIpRange = new gcp.compute.GlobalAddress(
        "gtmship-private-ip-range",
        {
          purpose: "VPC_PEERING",
          addressType: "INTERNAL",
          prefixLength: 16,
          network: network.id,
        },
      );

      const privateConnection = new gcp.servicenetworking.Connection(
        "gtmship-private-connection",
        {
          network: network.id,
          service: "servicenetworking.googleapis.com",
          reservedPeeringRanges: [privateIpRange.name],
        },
      );

      const dbPassword = config.dbPassword ?? generatePassword(24);

      sqlInstance = new gcp.sql.DatabaseInstance(
        "gtmship-db",
        {
          databaseVersion: "POSTGRES_16",
          region: config.region,
          deletionProtection: false,
          settings: {
            tier: "db-f1-micro",
            ipConfiguration: {
              ipv4Enabled: false,
              privateNetwork: network.id,
            },
            userLabels: { project: config.projectName.toLowerCase() },
          },
        },
        { dependsOn: [privateConnection] },
      );

      new gcp.sql.Database("gtmship-database", {
        instance: sqlInstance.name,
        name: DB_NAME,
      });

      new gcp.sql.User("gtmship-db-user", {
        instance: sqlInstance.name,
        name: DB_USERNAME,
        password: dbPassword,
      });

      new gcp.projects.IAMMember("gtmship-sa-cloudsql", {
        project: config.gcpProject,
        role: "roles/cloudsql.client",
        member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
      });

      outputs["cloudSqlEndpoint"] = sqlInstance.privateIpAddress;
    }

    // -----------------------------------------------------------------------
    // Cloud Storage (only when storage is needed)
    // -----------------------------------------------------------------------

    if (needs.storage) {
      const bucket = new gcp.storage.Bucket("gtmship-artifacts", {
        location: config.region,
        forceDestroy: true,
        uniformBucketLevelAccess: true,
        labels: { project: config.projectName.toLowerCase() },
      });

      new gcp.projects.IAMMember("gtmship-sa-storage", {
        project: config.gcpProject,
        role: "roles/storage.objectAdmin",
        member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
      });

      outputs["gcsBucket"] = bucket.name;
    }

    // -----------------------------------------------------------------------
    // Cloud Run Job (for schedule/event workflows)
    // -----------------------------------------------------------------------

    const containerImage =
      config.serviceCodePath ??
      "us-docker.pkg.dev/cloudrun/container/hello";

    if (needs.executionKind === "job") {
      const cloudRunJob = new gcp.cloudrunv2.Job("gtmship-job", {
        location: config.region,
        template: {
          template: {
            serviceAccount: serviceAccount.email,
            containers: [
              {
                image: containerImage,
                resources: {
                  limits: {
                    memory: needs.memory || DEFAULT_MEMORY,
                    cpu: needs.cpu || DEFAULT_CPU,
                  },
                },
                envs: [
                  { name: "NODE_OPTIONS", value: "--enable-source-maps" },
                  ...(config.runtimeEnvVars || []),
                ],
              },
            ],
            timeout: "300s",
            maxRetries: 1,
          },
        },
        labels: { project: config.projectName.toLowerCase() },
      });

      outputs["serviceId"] = cloudRunJob.name;
      outputs["serviceUrl"] = pulumi.interpolate`job:${cloudRunJob.name}`;

      // Cloud Scheduler to trigger the job
      if (needs.cloudScheduler && needs.scheduleCron) {
        const schedulerJob = new gcp.cloudscheduler.Job("gtmship-scheduler", {
          region: config.region,
          schedule: needs.scheduleCron,
          timeZone: needs.scheduleTimezone || "UTC",
          httpTarget: {
            uri: pulumi.interpolate`https://${config.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.gcpProject}/jobs/${cloudRunJob.name}:run`,
            httpMethod: "POST",
            oauthToken: {
              serviceAccountEmail: serviceAccount.email,
            },
          },
        });

        outputs["schedulerJobId"] = schedulerJob.name;
      }
    } else {
      // -----------------------------------------------------------------------
      // Cloud Run Service (for webhook/long-running workflows)
      // -----------------------------------------------------------------------

      const cloudRunService = new gcp.cloudrunv2.Service("gtmship-service", {
        location: config.region,
        ingress: needs.publicIngress
          ? "INGRESS_TRAFFIC_ALL"
          : "INGRESS_TRAFFIC_INTERNAL_ONLY",
        template: {
          serviceAccount: serviceAccount.email,
          containers: [
            {
              image: containerImage,
              resources: {
                limits: {
                  memory: needs.memory || DEFAULT_MEMORY,
                  cpu: needs.cpu || DEFAULT_CPU,
                },
              },
              envs: [
                { name: "NODE_OPTIONS", value: "--enable-source-maps" },
                ...(config.runtimeEnvVars || []),
              ],
            },
          ],
          timeout: "60s",
        },
        labels: { project: config.projectName.toLowerCase() },
      });

      // Allow unauthenticated access only when public ingress is needed (webhook triggers)
      if (needs.publicIngress) {
        new gcp.cloudrunv2.ServiceIamMember("gtmship-service-public", {
          project: config.gcpProject,
          location: config.region,
          name: cloudRunService.name,
          role: "roles/run.invoker",
          member: "allUsers",
        });
      }

      outputs["serviceUrl"] = cloudRunService.uri;
      outputs["serviceId"] = cloudRunService.name;
    }

    return outputs;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deploy GTMShip workflow infrastructure to GCP — only what's needed.
 */
export async function deployToGcp(
  config: GcpConfig,
): Promise<GcpDeployResult> {
  const needs = config.needs;
  const parts: string[] = [];
  parts.push(needs.executionKind === "job" ? "Cloud Run Job" : "Cloud Run Service");
  if (needs.cloudScheduler) parts.push("Cloud Scheduler");
  if (needs.secretManager) parts.push("Secret Manager IAM");
  if (needs.database) parts.push("Cloud SQL");
  if (needs.storage) parts.push("Cloud Storage");

  console.log(`Deploying to GCP ${config.region}: ${parts.join(", ")}`);

  const stack = await LocalWorkspace.createOrSelectStack({
    stackName: config.projectName,
    projectName: PULUMI_PROJECT,
    program: createPulumiProgram(config),
  });

  console.log("Configuring GCP project and region...");
  await stack.setConfig("gcp:project", { value: config.gcpProject });
  await stack.setConfig("gcp:region", { value: config.region });

  console.log("Running pulumi up...");
  const result = await stack.up({
    onOutput: (msg: string) => {
      process.stdout.write(msg);
    },
  });

  const outputs = result.outputs;
  const serviceUrl = (outputs["serviceUrl"]?.value as string) || "";
  const serviceId = (outputs["serviceId"]?.value as string) || "";
  const schedulerJobId = (outputs["schedulerJobId"]?.value as string) || "";

  return {
    serviceUrl,
    serviceId,
    cloudSqlEndpoint: (outputs["cloudSqlEndpoint"]?.value as string) || "",
    gcsBucket: (outputs["gcsBucket"]?.value as string) || "",
    schedulerJobId,
    runtimeTarget: {
      kind: needs.executionKind,
      name: serviceId,
      endpointUrl: serviceUrl,
      schedulerJobId: schedulerJobId || undefined,
    },
  };
}

/**
 * Retrieve the current deploy status and stack outputs for a GCP project.
 */
export async function getGcpDeployStatus(
  projectName: string,
): Promise<DeployStatus> {
  try {
    const stack = await LocalWorkspace.selectStack({
      stackName: projectName,
      projectName: PULUMI_PROJECT,
      program: async () => {},
    });

    const info = await stack.info();
    const outputs = await stack.outputs();

    const flatOutputs: Record<string, string> = {};
    for (const [key, val] of Object.entries(outputs)) {
      flatOutputs[key] = String(val.value);
    }

    return {
      isDeployed: info !== undefined,
      outputs: flatOutputs,
      lastUpdate: info?.startTime?.toString(),
    };
  } catch {
    return {
      isDeployed: false,
      outputs: {},
    };
  }
}

/**
 * Destroy all GCP resources managed by the stack and remove the stack.
 */
export async function destroyGcpStack(projectName: string): Promise<void> {
  console.log(`Destroying GCP stack "${projectName}"...`);

  const stack = await LocalWorkspace.selectStack({
    stackName: projectName,
    projectName: PULUMI_PROJECT,
    program: async () => {},
  });

  await stack.destroy({
    onOutput: (msg: string) => {
      process.stdout.write(msg);
    },
  });

  console.log("Removing stack from state...");
  await stack.workspace.removeStack(projectName);

  console.log(`GCP stack "${projectName}" destroyed and removed.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random alphanumeric password of the given length. */
function generatePassword(length: number): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
