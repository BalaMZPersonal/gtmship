/**
 * AWS Deployment Engine
 *
 * Uses Pulumi Automation API to provision:
 * - VPC with public and private subnets (via @pulumi/awsx)
 * - RDS PostgreSQL (auth-service + state)
 * - S3 bucket (workflow artifacts)
 * - IAM role for Lambda (least-privilege)
 * - Lambda function (workflow runtime, Node.js 20)
 * - API Gateway v2 HTTP API (webhook ingress)
 * - Security groups for RDS and Lambda
 */

import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwsConfig {
  region: string;
  projectName: string;
  compute: "lambda" | "ecs";
  /** Workflow identifier for per-workflow stack scoping. */
  workflowId?: string;
  /** Optional DB password. A random one is generated if omitted. */
  dbPassword?: string;
  /** Optional path to the zipped Lambda handler code. */
  lambdaCodePath?: string;
  /** Runtime environment variables to inject into the Lambda function. */
  runtimeEnvVars?: Record<string, string>;
  /** Resource needs derived from the workflow plan. */
  needs?: AwsResourceNeeds;
}

export interface AwsResourceNeeds {
  publicIngress?: boolean;
  cloudScheduler?: boolean;
  scheduleCron?: string;
  scheduleTimezone?: string;
  secretManager?: boolean;
  database?: boolean;
  storage?: boolean;
  memory?: number | string;
  cpu?: number | string;
}

export interface AwsRuntimeTarget {
  computeType: "lambda";
  computeName: string;
  endpointUrl: string;
  schedulerJobId?: string;
  region: string;
  logGroupName: string;
}

export interface DeployResult {
  apiGatewayUrl: string;
  lambdaArn: string;
  lambdaName: string;
  logGroupName: string;
  schedulerJobId: string;
  endpointToken: string;
  runtimeTarget: AwsRuntimeTarget;
  rdsEndpoint: string;
  s3Bucket: string;
}

export interface DeployStatus {
  isDeployed: boolean;
  outputs: Record<string, string>;
  lastUpdate?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PULUMI_PROJECT = "gtmship";
const DB_NAME = "gtmship";
const DB_USERNAME = "gtmship_admin";
const DEFAULT_LAMBDA_MEMORY_MB = 256;
const MIN_LAMBDA_MEMORY_MB = 128;
const MAX_LAMBDA_MEMORY_MB = 10240;
const SINGLE_VCPU_MEMORY_MB = 1769;

// ---------------------------------------------------------------------------
// Pulumi inline program
// ---------------------------------------------------------------------------

function createPulumiProgram(config: AwsConfig) {
  return async (): Promise<Record<string, pulumi.Output<string>>> => {
    const needs = config.needs || {};
    const lambdaMemorySize = resolveLambdaMemorySizeMb(needs);

    // -----------------------------------------------------------------------
    // VPC — 2 public + 2 private subnets, single NAT gateway to save cost
    // -----------------------------------------------------------------------
    const vpc = new awsx.ec2.Vpc("gtmship-vpc", {
      numberOfAvailabilityZones: 2,
      subnetStrategy: "Auto",
      natGateways: { strategy: awsx.ec2.NatGatewayStrategy.Single },
      tags: { Project: config.projectName },
    });

    // -----------------------------------------------------------------------
    // Security Groups
    // -----------------------------------------------------------------------

    const lambdaSg = new aws.ec2.SecurityGroup("gtmship-lambda-sg", {
      vpcId: vpc.vpcId,
      description: "Security group for GTMShip Lambda functions",
      egress: [
        {
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          description: "Allow all outbound traffic",
        },
      ],
      tags: { Project: config.projectName },
    });

    const rdsSg = new aws.ec2.SecurityGroup("gtmship-rds-sg", {
      vpcId: vpc.vpcId,
      description: "Security group for GTMShip RDS instance",
      ingress: [
        {
          protocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          securityGroups: [lambdaSg.id],
          description: "Allow PostgreSQL from Lambda SG",
        },
      ],
      egress: [
        {
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          description: "Allow all outbound traffic",
        },
      ],
      tags: { Project: config.projectName },
    });

    // -----------------------------------------------------------------------
    // RDS PostgreSQL
    // -----------------------------------------------------------------------

    const dbPassword = config.dbPassword ?? generatePassword(24);
    const dbSubnetGroup = needs.database
      ? new aws.rds.SubnetGroup("gtmship-db-subnets", {
          subnetIds: vpc.privateSubnetIds,
          tags: { Project: config.projectName },
        })
      : null;

    const db = needs.database
      ? new aws.rds.Instance("gtmship-db", {
          engine: "postgres",
          engineVersion: "16",
          instanceClass: "db.t3.micro",
          allocatedStorage: 20,
          maxAllocatedStorage: 50,
          dbName: DB_NAME,
          username: DB_USERNAME,
          password: dbPassword,
          dbSubnetGroupName: dbSubnetGroup?.name,
          vpcSecurityGroupIds: [rdsSg.id],
          skipFinalSnapshot: true,
          publiclyAccessible: false,
          storageEncrypted: true,
          tags: { Project: config.projectName },
        })
      : null;

    // -----------------------------------------------------------------------
    // S3 Bucket — workflow artifacts
    // -----------------------------------------------------------------------

    const bucket = needs.storage
      ? new aws.s3.BucketV2("gtmship-artifacts", {
          forceDestroy: true,
          tags: { Project: config.projectName },
        })
      : null;

    if (bucket) {
      new aws.s3.BucketServerSideEncryptionConfigurationV2(
        "gtmship-artifacts-sse",
        {
          bucket: bucket.id,
          rules: [
            {
              applyServerSideEncryptionByDefault: {
                sseAlgorithm: "AES256",
              },
            },
          ],
        },
      );

      new aws.s3.BucketPublicAccessBlock("gtmship-artifacts-pab", {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }

    // -----------------------------------------------------------------------
    // IAM Role for Lambda — least-privilege
    // -----------------------------------------------------------------------

    const lambdaRole = new aws.iam.Role("gtmship-lambda-role", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: { Project: config.projectName },
    });

    // CloudWatch Logs
    new aws.iam.RolePolicyAttachment("gtmship-lambda-logs", {
      role: lambdaRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    // VPC access (ENI management for Lambda in VPC)
    new aws.iam.RolePolicyAttachment("gtmship-lambda-vpc", {
      role: lambdaRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
    });

    // S3 + RDS connect — scoped inline policy
    const lambdaPolicyStatements = buildAwsPolicyStatements({
      bucketArn: bucket ? "__dynamic_bucket__" : null,
      dbArn: db ? "__dynamic_db__" : null,
      secretManager: Boolean(needs.secretManager),
    });

    if (lambdaPolicyStatements.length > 0) {
      new aws.iam.RolePolicy("gtmship-lambda-inline", {
        role: lambdaRole.id,
        policy: pulumi
          .all([bucket?.arn, db?.arn])
          .apply(([bucketArn, dbArn]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: buildAwsPolicyStatements({
                bucketArn: bucketArn || null,
                dbArn: dbArn || null,
                secretManager: Boolean(needs.secretManager),
              }),
            }),
          ),
      });
    }

    // -----------------------------------------------------------------------
    // Lambda Function — workflow runtime
    // -----------------------------------------------------------------------

    // If no code path is provided, deploy a minimal placeholder handler
    const lambdaFn = new aws.lambda.Function("gtmship-worker", {
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: lambdaRole.arn,
      timeout: 60,
      memorySize: lambdaMemorySize,
      code: config.lambdaCodePath
        ? new pulumi.asset.FileArchive(config.lambdaCodePath)
        : new pulumi.asset.AssetArchive({
            "index.mjs": new pulumi.asset.StringAsset(
              `export const handler = async (event) => {
  const body = event.body ? JSON.parse(event.body) : {};
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, received: body }),
  };
};`,
            ),
          }),
      vpcConfig: {
        subnetIds: vpc.privateSubnetIds,
        securityGroupIds: [lambdaSg.id],
      },
      environment: {
        variables: {
          NODE_OPTIONS: "--enable-source-maps",
          ...(db
            ? {
                DATABASE_URL: pulumi.interpolate`postgresql://${DB_USERNAME}:${dbPassword}@${db.endpoint}/${DB_NAME}`,
              }
            : {}),
          ...(bucket ? { S3_BUCKET: bucket.bucket } : {}),
          ...(config.runtimeEnvVars || {}),
        },
      },
      tags: { Project: config.projectName },
    });

    const logGroupName = lambdaFn.name.apply(buildAwsLogGroupName);

    // -----------------------------------------------------------------------
    // API Gateway v2 (HTTP API) — webhook ingress
    // -----------------------------------------------------------------------

    const api = needs.publicIngress
      ? new aws.apigatewayv2.Api("gtmship-api", {
          protocolType: "HTTP",
          description: `GTMShip webhook ingress for ${config.projectName}`,
          tags: { Project: config.projectName },
        })
      : null;

    if (api) {
      new aws.lambda.Permission("gtmship-api-lambda-permission", {
        action: "lambda:InvokeFunction",
        function: lambdaFn.arn,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
      });

      const integration = new aws.apigatewayv2.Integration(
        "gtmship-api-integration",
        {
          apiId: api.id,
          integrationType: "AWS_PROXY",
          integrationUri: lambdaFn.invokeArn,
          payloadFormatVersion: "2.0",
        },
      );

      new aws.apigatewayv2.Route("gtmship-api-route", {
        apiId: api.id,
        routeKey: "$default",
        target: pulumi.interpolate`integrations/${integration.id}`,
      });

      new aws.apigatewayv2.Stage("gtmship-api-stage", {
        apiId: api.id,
        name: "$default",
        autoDeploy: true,
        tags: { Project: config.projectName },
      });
    }

    // -----------------------------------------------------------------------
    // EventBridge Scheduler — schedule trigger
    // -----------------------------------------------------------------------

    const schedulerRole =
      needs.cloudScheduler && needs.scheduleCron
        ? new aws.iam.Role("gtmship-scheduler-role", {
            assumeRolePolicy: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "scheduler.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            tags: { Project: config.projectName },
          })
        : null;

    if (schedulerRole) {
      new aws.iam.RolePolicy("gtmship-scheduler-invoke", {
        role: schedulerRole.id,
        policy: lambdaFn.arn.apply((lambdaArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["lambda:InvokeFunction"],
                Resource: [lambdaArn],
              },
            ],
          }),
        ),
      });
    }

    const schedulerJob =
      schedulerRole && needs.scheduleCron
        ? new aws.scheduler.Schedule("gtmship-schedule", {
            scheduleExpression: toEventBridgeScheduleExpression(
              needs.scheduleCron,
            ),
            scheduleExpressionTimezone: needs.scheduleTimezone || "UTC",
            flexibleTimeWindow: { mode: "OFF" },
            target: {
              arn: lambdaFn.arn,
              roleArn: schedulerRole.arn,
              input: JSON.stringify({
                source: "aws.scheduler",
              }),
            },
          })
        : null;

    const apiGatewayUrl = api?.apiEndpoint || pulumi.output("");
    const schedulerJobId = schedulerJob?.name || pulumi.output("");
    const endpointToken = pulumi
      .all([apiGatewayUrl, lambdaFn.name])
      .apply(([apiEndpoint, lambdaName]) =>
        buildAwsEndpointToken(apiEndpoint, lambdaName),
      );

    // -----------------------------------------------------------------------
    // Stack outputs
    // -----------------------------------------------------------------------

    return {
      apiGatewayUrl,
      lambdaArn: lambdaFn.arn,
      lambdaName: lambdaFn.name,
      logGroupName,
      schedulerJobId,
      endpointToken,
      rdsEndpoint: db?.endpoint || pulumi.output(""),
      s3Bucket: bucket?.bucket || pulumi.output(""),
    };
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deploy the GTMShip infrastructure to AWS using Pulumi Automation API.
 */
export async function deployToAws(config: AwsConfig): Promise<DeployResult> {
  console.log(`Deploying GTMShip to AWS ${config.region}...`);

  const stackName = buildAwsStackName(config.projectName, config.workflowId);
  const stack = await LocalWorkspace.createOrSelectStack({
    stackName,
    projectName: PULUMI_PROJECT,
    program: createPulumiProgram(config),
  });

  console.log("Configuring AWS region...");
  await stack.setConfig("aws:region", { value: config.region });

  console.log("Running pulumi up...");
  const result = await stack.up({
    onOutput: (msg: string) => {
      process.stdout.write(msg);
    },
  });

  const outputs = result.outputs;

  const apiGatewayUrl = (outputs["apiGatewayUrl"]?.value as string) || "";
  const lambdaArn = (outputs["lambdaArn"]?.value as string) || "";
  const lambdaName =
    (outputs["lambdaName"]?.value as string) || extractLambdaName(lambdaArn) || "";
  const logGroupName =
    (outputs["logGroupName"]?.value as string) ||
    (lambdaName ? buildAwsLogGroupName(lambdaName) : "");
  const schedulerJobId = (outputs["schedulerJobId"]?.value as string) || "";
  const endpointToken =
    (outputs["endpointToken"]?.value as string) ||
    buildAwsEndpointToken(apiGatewayUrl, lambdaName);

  return {
    apiGatewayUrl,
    lambdaArn,
    lambdaName,
    logGroupName,
    schedulerJobId,
    endpointToken,
    runtimeTarget: {
      computeType: "lambda",
      computeName: lambdaName,
      endpointUrl: endpointToken,
      schedulerJobId: schedulerJobId || undefined,
      region: config.region,
      logGroupName,
    },
    rdsEndpoint: (outputs["rdsEndpoint"]?.value as string) || "",
    s3Bucket: (outputs["s3Bucket"]?.value as string) || "",
  };
}

/**
 * Retrieve the current deploy status and stack outputs for a project.
 */
export async function getDeployStatus(
  projectName: string,
): Promise<DeployStatus> {
  try {
    const stack = await LocalWorkspace.selectStack({
      stackName: projectName,
      projectName: PULUMI_PROJECT,
      // A dummy program is needed by the API but won't be executed for reads.
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
 * Destroy all AWS resources managed by the stack and remove the stack.
 */
export async function destroyStack(projectName: string): Promise<void> {
  console.log(`Destroying stack "${projectName}"...`);

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

  console.log(`Stack "${projectName}" destroyed and removed.`);
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

function sanitizeWorkflowSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildAwsStackName(projectName: string, workflowId?: string): string {
  const normalizedWorkflowId = workflowId ? sanitizeWorkflowSlug(workflowId) : "";
  return normalizedWorkflowId ? `${projectName}-${normalizedWorkflowId}` : projectName;
}

function buildAwsPolicyStatements(input: {
  bucketArn: string | null;
  dbArn: string | null;
  secretManager: boolean;
}): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [];

  if (input.bucketArn) {
    statements.push({
      Sid: "S3WorkflowArtifacts",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
      ],
      Resource: [input.bucketArn, `${input.bucketArn}/*`],
    });
  }

  if (input.dbArn) {
    statements.push({
      Sid: "RdsConnect",
      Effect: "Allow",
      Action: ["rds-db:connect"],
      Resource: [input.dbArn],
    });
  }

  if (input.secretManager) {
    statements.push({
      Sid: "SecretsManagerAccess",
      Effect: "Allow",
      Action: [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
      ],
      Resource: ["*"],
    });
  }

  return statements;
}

function toMemoryMb(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampLambdaMemory(Math.ceil(value));
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return clampLambdaMemory(Math.ceil(numeric));
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)(mi|mib|gi|gib|mb|gb)$/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount)) {
    return null;
  }

  if (unit === "gi" || unit === "gib" || unit === "gb") {
    return clampLambdaMemory(Math.ceil(amount * 1024));
  }

  return clampLambdaMemory(Math.ceil(amount));
}

function toCpuUnits(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.endsWith("m")) {
    const milli = Number(trimmed.slice(0, -1));
    return Number.isFinite(milli) && milli > 0 ? milli / 1000 : null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampLambdaMemory(value: number): number {
  return Math.max(
    MIN_LAMBDA_MEMORY_MB,
    Math.min(MAX_LAMBDA_MEMORY_MB, value),
  );
}

function resolveLambdaMemorySizeMb(needs: AwsResourceNeeds): number {
  const requestedMemory = toMemoryMb(needs.memory) || DEFAULT_LAMBDA_MEMORY_MB;
  const requestedCpu = toCpuUnits(needs.cpu);
  const cpuDerivedMemory = requestedCpu
    ? clampLambdaMemory(Math.ceil(requestedCpu * SINGLE_VCPU_MEMORY_MB))
    : 0;

  return Math.max(requestedMemory, cpuDerivedMemory);
}

function toEventBridgeScheduleExpression(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("AWS schedule triggers require a cron expression.");
  }

  if (
    trimmed.startsWith("cron(") ||
    trimmed.startsWith("rate(") ||
    trimmed.startsWith("at(")
  ) {
    return trimmed;
  }

  const fields = trimmed.split(/\s+/).filter(Boolean);
  if (fields.length === 5) {
    const [minute, hour, dayOfMonthRaw, month, dayOfWeekRaw] = fields;
    let dayOfMonth = dayOfMonthRaw;
    let dayOfWeek = dayOfWeekRaw;

    if (dayOfMonth === "*" && dayOfWeek === "*") {
      dayOfWeek = "?";
    } else if (dayOfMonth === "*") {
      dayOfMonth = "?";
    } else if (dayOfWeek === "*") {
      dayOfWeek = "?";
    } else {
      throw new Error(
        `AWS schedule cron "${trimmed}" is not supported. Use a schedule where either day-of-month or day-of-week is "*".`,
      );
    }

    return `cron(${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} *)`;
  }

  if (fields.length === 6) {
    return `cron(${trimmed})`;
  }

  throw new Error(
    `AWS schedule cron "${trimmed}" is not supported. Expected a 5-field standard cron expression.`,
  );
}

function buildAwsLogGroupName(lambdaName: string): string {
  return `/aws/lambda/${lambdaName}`;
}

function buildAwsEndpointToken(
  apiGatewayUrl: string | null | undefined,
  lambdaName: string | null | undefined,
): string {
  const httpEndpoint = apiGatewayUrl?.trim();
  if (httpEndpoint) {
    return httpEndpoint;
  }

  const normalizedLambdaName = lambdaName?.trim();
  return normalizedLambdaName ? `lambda:${normalizedLambdaName}` : "";
}

function extractLambdaName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("lambda:")) {
    return trimmed.slice("lambda:".length) || null;
  }

  const arnMatch = trimmed.match(/:function:([^:/]+)(?::[^/]+)?$/);
  if (arnMatch?.[1]) {
    return arnMatch[1];
  }

  return trimmed.startsWith("arn:") ? null : trimmed;
}
