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
  /** Optional DB password. A random one is generated if omitted. */
  dbPassword?: string;
  /** Optional path to the zipped Lambda handler code. */
  lambdaCodePath?: string;
  /** Runtime environment variables to inject into the Lambda function. */
  runtimeEnvVars?: Record<string, string>;
}

export interface DeployResult {
  apiGatewayUrl: string;
  lambdaArn: string;
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

// ---------------------------------------------------------------------------
// Pulumi inline program
// ---------------------------------------------------------------------------

function createPulumiProgram(config: AwsConfig) {
  return async (): Promise<Record<string, pulumi.Output<string>>> => {
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

    const dbSubnetGroup = new aws.rds.SubnetGroup("gtmship-db-subnets", {
      subnetIds: vpc.privateSubnetIds,
      tags: { Project: config.projectName },
    });

    const dbPassword = config.dbPassword ?? generatePassword(24);

    const db = new aws.rds.Instance("gtmship-db", {
      engine: "postgres",
      engineVersion: "16",
      instanceClass: "db.t3.micro",
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      dbName: DB_NAME,
      username: DB_USERNAME,
      password: dbPassword,
      dbSubnetGroupName: dbSubnetGroup.name,
      vpcSecurityGroupIds: [rdsSg.id],
      skipFinalSnapshot: true,
      publiclyAccessible: false,
      storageEncrypted: true,
      tags: { Project: config.projectName },
    });

    // -----------------------------------------------------------------------
    // S3 Bucket — workflow artifacts
    // -----------------------------------------------------------------------

    const bucket = new aws.s3.BucketV2("gtmship-artifacts", {
      forceDestroy: true,
      tags: { Project: config.projectName },
    });

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
    new aws.iam.RolePolicy(
      "gtmship-lambda-inline",
      {
        role: lambdaRole.id,
        policy: pulumi.all([bucket.arn, db.arn]).apply(([bucketArn, dbArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "S3WorkflowArtifacts",
                Effect: "Allow",
                Action: [
                  "s3:GetObject",
                  "s3:PutObject",
                  "s3:DeleteObject",
                  "s3:ListBucket",
                ],
                Resource: [bucketArn, `${bucketArn}/*`],
              },
              {
                Sid: "RdsConnect",
                Effect: "Allow",
                Action: ["rds-db:connect"],
                Resource: [dbArn],
              },
            ],
          }),
        ),
      },
    );

    // -----------------------------------------------------------------------
    // Lambda Function — workflow runtime
    // -----------------------------------------------------------------------

    // If no code path is provided, deploy a minimal placeholder handler
    const lambdaFn = new aws.lambda.Function("gtmship-worker", {
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: lambdaRole.arn,
      timeout: 60,
      memorySize: 256,
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
          DATABASE_URL: pulumi.interpolate`postgresql://${DB_USERNAME}:${dbPassword}@${db.endpoint}/${DB_NAME}`,
          S3_BUCKET: bucket.bucket,
          NODE_OPTIONS: "--enable-source-maps",
          ...(config.runtimeEnvVars || {}),
        },
      },
      tags: { Project: config.projectName },
    });

    // -----------------------------------------------------------------------
    // API Gateway v2 (HTTP API) — webhook ingress
    // -----------------------------------------------------------------------

    const api = new aws.apigatewayv2.Api("gtmship-api", {
      protocolType: "HTTP",
      description: `GTMShip webhook ingress for ${config.projectName}`,
      tags: { Project: config.projectName },
    });

    new aws.lambda.Permission(
      "gtmship-api-lambda-permission",
      {
        action: "lambda:InvokeFunction",
        function: lambdaFn.arn,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
      },
    );

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

    // -----------------------------------------------------------------------
    // Stack outputs
    // -----------------------------------------------------------------------

    return {
      apiGatewayUrl: api.apiEndpoint,
      lambdaArn: lambdaFn.arn,
      rdsEndpoint: db.endpoint,
      s3Bucket: bucket.bucket,
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

  const stack = await LocalWorkspace.createOrSelectStack({
    stackName: config.projectName,
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

  return {
    apiGatewayUrl: outputs["apiGatewayUrl"]?.value as string,
    lambdaArn: outputs["lambdaArn"]?.value as string,
    rdsEndpoint: outputs["rdsEndpoint"]?.value as string,
    s3Bucket: outputs["s3Bucket"]?.value as string,
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
