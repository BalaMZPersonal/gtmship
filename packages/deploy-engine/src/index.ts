export {
  deployToAws,
  getDeployStatus,
  destroyStack,
  type AwsConfig,
  type DeployResult,
  type DeployStatus,
} from "./aws.js";

export {
  deployToGcp,
  getGcpDeployStatus,
  destroyGcpStack,
  type GcpConfig,
  type GcpDeployResult,
  type GcpRuntimeTarget,
  type GcpResourceNeeds,
} from "./gcp.js";

export {
  buildGcpLogFilter,
  fetchLogs,
  streamLogs,
  parseDuration,
  type GcpLogTargetKind,
  type LogQuery,
  type LogEntry,
  type LogResult,
} from "./logs.js";

export {
  buildTriggerInfo,
  buildAllTriggerInfo,
  formatTriggerInfo,
  type TriggerInfo,
} from "./triggers.js";

export {
  buildWorkflowDeploymentPlan,
  extractTriggerFromSource,
  getDefaultExecutionKind,
  planWorkflowDeployment,
  planWorkflowDeployments,
  validateGcpResourceConstraints,
  type GcpValidationError,
  type DeployTarget as PlannedDeployTarget,
  type PlannedResource,
  type PlannedTriggerSummary,
  type PlannerConnectionRecord,
  type SharedWorkflowDeploymentPlanInput,
  type WorkflowBinding as PlannedWorkflowBinding,
  type WorkflowBindingPlan,
  type WorkflowBindingSelector as PlannedWorkflowBindingSelector,
  type WorkflowBindingSelectorType,
  type WorkflowCloudProvider,
  type WorkflowDeployAuthModeInput,
  type LegacyWorkflowDeployAuthMode,
  type WorkflowDeployAuthConfig as PlannedWorkflowDeployAuthConfig,
  type WorkflowDeployAuthMode,
  type WorkflowPlannedAuth,
  type WorkflowRuntimeAuthManifest,
  type WorkflowRuntimeAuthManifestProvider,
  type WorkflowSecretBackendKind,
  type WorkflowSecretRuntimeAccessMode,
  type WorkflowDeploymentPlan,
  type WorkflowEventTriggerConfiguration,
  type WorkflowExecutionConfig,
  type WorkflowExecutionKind,
  type WorkflowPlanInput,
  type WorkflowScheduleTriggerConfiguration,
  type WorkflowTriggerConfiguration,
  type WorkflowWebhookTriggerConfiguration,
} from "./planner.js";

import { deployToAws, type DeployResult } from "./aws.js";
import { deployToGcp, type GcpDeployResult, type GcpResourceNeeds } from "./gcp.js";

export interface DeployConfig {
  provider: "aws" | "gcp";
  region: string;
  compute: "lambda" | "ecs" | "cloud-run";
  projectName: string;
  /** Optional DB password — auto-generated if omitted. */
  dbPassword?: string;
  /** Optional path to zipped Lambda handler code. */
  lambdaCodePath?: string;
  /** GCP project ID — required when provider is "gcp". */
  gcpProject?: string;
  /** Optional path to container image or source archive (GCP). */
  serviceCodePath?: string;
  /** Resource needs derived from workflow plans. When omitted, deploys a Cloud Run Service with no extras. */
  gcpNeeds?: GcpResourceNeeds;
  /** Runtime environment variables to inject into the compute target. */
  runtimeEnvVars?: Record<string, string>;
}

export interface UnifiedDeployResult {
  provider: "aws" | "gcp";
  apiEndpoint: string;
  computeId: string;
  databaseEndpoint: string;
  storageBucket: string;
  schedulerJobId: string;
  gcpTarget?: {
    kind: "service" | "job";
    name: string;
    endpointUrl: string;
    schedulerJobId?: string;
    projectId: string;
    region: string;
  };
  rawOutputs: Record<string, string>;
}

/**
 * Deploy GTMShip infrastructure to the specified cloud provider.
 */
export async function deploy(
  config: DeployConfig,
): Promise<UnifiedDeployResult> {
  switch (config.provider) {
    case "aws": {
      const result: DeployResult = await deployToAws({
        region: config.region,
        projectName: config.projectName,
        compute: config.compute as "lambda" | "ecs",
        dbPassword: config.dbPassword,
        lambdaCodePath: config.lambdaCodePath,
        runtimeEnvVars: config.runtimeEnvVars,
      });

      return {
        provider: "aws",
        apiEndpoint: result.apiGatewayUrl,
        computeId: result.lambdaArn,
        databaseEndpoint: result.rdsEndpoint,
        storageBucket: result.s3Bucket,
        schedulerJobId: "",
        rawOutputs: {
          apiGatewayUrl: result.apiGatewayUrl,
          lambdaArn: result.lambdaArn,
          rdsEndpoint: result.rdsEndpoint,
          s3Bucket: result.s3Bucket,
        },
      };
    }
    case "gcp": {
      if (!config.gcpProject) {
        throw new Error("gcpProject is required for GCP deployments");
      }

      const needs: GcpResourceNeeds = config.gcpNeeds || {
        executionKind: "service",
      };

      const gcpEnvVars = config.runtimeEnvVars
        ? Object.entries(config.runtimeEnvVars).map(([name, value]) => ({ name, value }))
        : undefined;

      const result: GcpDeployResult = await deployToGcp({
        region: config.region,
        projectName: config.projectName,
        gcpProject: config.gcpProject,
        needs,
        dbPassword: config.dbPassword,
        serviceCodePath: config.serviceCodePath,
        runtimeEnvVars: gcpEnvVars,
      });

      return {
        provider: "gcp",
        apiEndpoint: result.serviceUrl,
        computeId: result.serviceId,
        databaseEndpoint: result.cloudSqlEndpoint,
        storageBucket: result.gcsBucket,
        schedulerJobId: result.schedulerJobId,
        gcpTarget: {
          kind: result.runtimeTarget.kind,
          name: result.runtimeTarget.name,
          endpointUrl: result.runtimeTarget.endpointUrl,
          schedulerJobId: result.runtimeTarget.schedulerJobId,
          projectId: config.gcpProject,
          region: config.region,
        },
        rawOutputs: {
          serviceUrl: result.serviceUrl,
          serviceId: result.serviceId,
          cloudSqlEndpoint: result.cloudSqlEndpoint,
          gcsBucket: result.gcsBucket,
          schedulerJobId: result.schedulerJobId,
          gcpTargetKind: result.runtimeTarget.kind,
          gcpComputeName: result.runtimeTarget.name,
          gcpEndpointUrl: result.runtimeTarget.endpointUrl,
        },
      };
    }
    default:
      throw new Error(
        `Unsupported provider: ${(config as DeployConfig).provider}`,
      );
  }
}
