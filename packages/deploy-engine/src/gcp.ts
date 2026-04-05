/**
 * GCP Deployment Engine — needs-based provisioning
 *
 * Only creates the resources the workflow actually requires:
 * - Runtime service account + IAM (workflow-managed or legacy-shared reuse)
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
  /** Whether the workflow uses secret_manager auth mode (requires Secret Manager access). */
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
  /** Unique workflow identifier — used to scope resource names per workflow. */
  workflowId?: string;
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
const LEGACY_SHARED_GCP_RUNTIME_SERVICE_ACCOUNT_ID = "gtmship-cloudrun";
const WORKFLOW_GCP_RUNTIME_SERVICE_ACCOUNT_PREFIX = "gtmship-cr";

const DEFAULT_MEMORY = "512Mi";
const DEFAULT_CPU = "1";

interface GcpRuntimeIdentity {
  email: string;
  source: "legacy-shared";
}

// ---------------------------------------------------------------------------
// Pulumi inline program
// ---------------------------------------------------------------------------

function createPulumiProgram(
  config: GcpConfig,
  runtimeIdentity?: GcpRuntimeIdentity,
) {
  return async (): Promise<Record<string, pulumi.Output<string>>> => {
    const needs = config.needs;
    const outputs: Record<string, pulumi.Output<string>> = {};

    // Derive workflow-scoped prefix for resource names
    const slug = config.workflowId
      ? sanitizeWorkflowSlug(config.workflowId)
      : null;
    const rn = (base: string) => (slug ? `${base}-${slug}` : base);

    // -----------------------------------------------------------------------
    // Runtime service account
    // Reuse the legacy shared identity when a legacy stack already exists so
    // per-workflow stacks don't need to rewrite project IAM on every deploy.
    // -----------------------------------------------------------------------

    let runtimeServiceAccountEmail: pulumi.Input<string>;

    if (runtimeIdentity) {
      runtimeServiceAccountEmail = runtimeIdentity.email;
    } else {
      const serviceAccount = new gcp.serviceaccount.Account(
        rn("gtmship-sa"),
        {
          accountId: rn(WORKFLOW_GCP_RUNTIME_SERVICE_ACCOUNT_PREFIX),
          displayName: `GTMShip Cloud Run SA (${config.workflowId || config.projectName})`,
        },
      );

      runtimeServiceAccountEmail = serviceAccount.email;

      // Secret Manager access is only required when the runtime resolves
      // secrets directly from GCP Secret Manager.
      if (needs.secretManager) {
        new gcp.projects.IAMMember(rn("gtmship-sa-sec"), {
          project: config.gcpProject,
          role: "roles/secretmanager.secretAccessor",
          member: pulumi.interpolate`serviceAccount:${runtimeServiceAccountEmail}`,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Cloud SQL (only when database is needed)
    // -----------------------------------------------------------------------

    let sqlInstance: gcp.sql.DatabaseInstance | undefined;

    if (needs.database) {
      const network = new gcp.compute.Network(rn("gtmship-net"), {
        autoCreateSubnetworks: false,
        description: `GTMShip VPC for ${config.workflowId || config.projectName}`,
      });

      new gcp.compute.Subnetwork(rn("gtmship-sub"), {
        ipCidrRange: "10.0.0.0/24",
        region: config.region,
        network: network.id,
        privateIpGoogleAccess: true,
      });

      const router = new gcp.compute.Router(rn("gtmship-rtr"), {
        region: config.region,
        network: network.id,
      });

      new gcp.compute.RouterNat(rn("gtmship-nat"), {
        router: router.name,
        region: config.region,
        natIpAllocateOption: "AUTO_ONLY",
        sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
      });

      const privateIpRange = new gcp.compute.GlobalAddress(
        rn("gtmship-pip"),
        {
          purpose: "VPC_PEERING",
          addressType: "INTERNAL",
          prefixLength: 16,
          network: network.id,
        },
      );

      const privateConnection = new gcp.servicenetworking.Connection(
        rn("gtmship-pc"),
        {
          network: network.id,
          service: "servicenetworking.googleapis.com",
          reservedPeeringRanges: [privateIpRange.name],
        },
      );

      const dbPassword = config.dbPassword ?? generatePassword(24);

      sqlInstance = new gcp.sql.DatabaseInstance(
        rn("gtmship-db"),
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

      new gcp.sql.Database(rn("gtmship-database"), {
        instance: sqlInstance.name,
        name: DB_NAME,
      });

      new gcp.sql.User(rn("gtmship-dbu"), {
        instance: sqlInstance.name,
        name: DB_USERNAME,
        password: dbPassword,
      });

      new gcp.projects.IAMMember(rn("gtmship-sa-sql"), {
        project: config.gcpProject,
        role: "roles/cloudsql.client",
        member: pulumi.interpolate`serviceAccount:${runtimeServiceAccountEmail}`,
      });

      outputs["cloudSqlEndpoint"] = sqlInstance.privateIpAddress;
    }

    // -----------------------------------------------------------------------
    // Cloud Storage (only when storage is needed)
    // -----------------------------------------------------------------------

    if (needs.storage) {
      const bucket = new gcp.storage.Bucket(rn("gtmship-art"), {
        location: config.region,
        forceDestroy: true,
        uniformBucketLevelAccess: true,
        labels: { project: config.projectName.toLowerCase() },
      });

      new gcp.projects.IAMMember(rn("gtmship-sa-sto"), {
        project: config.gcpProject,
        role: "roles/storage.objectAdmin",
        member: pulumi.interpolate`serviceAccount:${runtimeServiceAccountEmail}`,
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
      const cloudRunJob = new gcp.cloudrunv2.Job(rn("gtmship-job"), {
        location: config.region,
        template: {
          template: {
            serviceAccount: runtimeServiceAccountEmail,
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
        const schedulerJob = new gcp.cloudscheduler.Job(rn("gtmship-sched"), {
          region: config.region,
          schedule: needs.scheduleCron,
          timeZone: needs.scheduleTimezone || "UTC",
          httpTarget: {
            uri: pulumi.interpolate`https://${config.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.gcpProject}/jobs/${cloudRunJob.name}:run`,
            httpMethod: "POST",
            oauthToken: {
              serviceAccountEmail: runtimeServiceAccountEmail,
            },
          },
        });

        outputs["schedulerJobId"] = schedulerJob.name;
      }
    } else {
      // -----------------------------------------------------------------------
      // Cloud Run Service (for webhook/long-running workflows)
      // -----------------------------------------------------------------------

      const cloudRunService = new gcp.cloudrunv2.Service(rn("gtmship-svc"), {
        location: config.region,
        ingress: needs.publicIngress
          ? "INGRESS_TRAFFIC_ALL"
          : "INGRESS_TRAFFIC_INTERNAL_ONLY",
        template: {
          serviceAccount: runtimeServiceAccountEmail,
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
        new gcp.cloudrunv2.ServiceIamMember(rn("gtmship-svc-pub"), {
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

  const stackName = config.workflowId
    ? `${config.projectName}-${sanitizeWorkflowSlug(config.workflowId)}`
    : config.projectName;
  const runtimeIdentity = await resolveGcpRuntimeIdentity(config, stackName);

  if (runtimeIdentity?.source === "legacy-shared") {
    console.log(
      `Reusing legacy shared GCP runtime service account ${runtimeIdentity.email} to preserve existing project IAM bindings...`,
    );
  }

  const stack = await LocalWorkspace.createOrSelectStack({
    stackName,
    projectName: PULUMI_PROJECT,
    program: createPulumiProgram(config, runtimeIdentity),
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
  workflowId?: string,
): Promise<DeployStatus> {
  const stackName = workflowId
    ? `${projectName}-${sanitizeWorkflowSlug(workflowId)}`
    : projectName;
  try {
    const stack = await LocalWorkspace.selectStack({
      stackName,
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
export async function destroyGcpStack(projectName: string, workflowId?: string): Promise<void> {
  const stackName = workflowId
    ? `${projectName}-${sanitizeWorkflowSlug(workflowId)}`
    : projectName;
  console.log(`Destroying GCP stack "${stackName}"...`);

  const stack = await LocalWorkspace.selectStack({
    stackName,
    projectName: PULUMI_PROJECT,
    program: async () => {},
  });

  await stack.destroy({
    onOutput: (msg: string) => {
      process.stdout.write(msg);
    },
  });

  console.log("Removing stack from state...");
  await stack.workspace.removeStack(stackName);

  console.log(`GCP stack "${stackName}" destroyed and removed.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a workflow ID into a valid GCP resource name suffix. */
function sanitizeWorkflowSlug(workflowId: string, maxLen = 18): string {
  return workflowId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

async function resolveGcpRuntimeIdentity(
  config: GcpConfig,
  stackName: string,
): Promise<GcpRuntimeIdentity | undefined> {
  // Database/storage flows still grant additional runtime roles, so keep the
  // reuse path narrow to the current per-workflow Cloud Run migration.
  if (!config.workflowId || config.needs.database || config.needs.storage) {
    return undefined;
  }

  if (stackName === config.projectName) {
    return undefined;
  }

  if (!(await gcpStackExists(config.projectName))) {
    return undefined;
  }

  return {
    email: buildServiceAccountEmail(
      config.gcpProject,
      LEGACY_SHARED_GCP_RUNTIME_SERVICE_ACCOUNT_ID,
    ),
    source: "legacy-shared",
  };
}

async function gcpStackExists(stackName: string): Promise<boolean> {
  try {
    await LocalWorkspace.selectStack({
      stackName,
      projectName: PULUMI_PROJECT,
      program: async () => {},
    });
    return true;
  } catch {
    return false;
  }
}

function buildServiceAccountEmail(projectId: string, accountId: string): string {
  return `${accountId}@${projectId}.iam.gserviceaccount.com`;
}

/** Generate a random alphanumeric password of the given length. */
function generatePassword(length: number): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
