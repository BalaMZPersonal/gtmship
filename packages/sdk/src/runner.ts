import { createWorkflowContext } from "./context.js";
import type { WorkflowConfig, WorkflowResult } from "./types.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

let cachedWorkflow: WorkflowConfig | undefined;

async function loadWorkflow(): Promise<WorkflowConfig> {
  if (cachedWorkflow) return cachedWorkflow;

  const rawPath = process.env.GTMSHIP_WORKFLOW_PATH || "./workflow.js";

  // Resolve relative paths against the directory of this runner file
  // so that "./workflow.js" always finds the sibling file regardless of cwd.
  let workflowPath = rawPath;
  if (rawPath.startsWith("./") || rawPath.startsWith("../")) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    workflowPath = "file://" + resolve(__dirname, rawPath);
  }

  const mod = await import(workflowPath);
  const config: WorkflowConfig = mod.default ?? mod;

  if (!config?.id || !config?.run) {
    throw new Error(
      `Invalid workflow module at "${workflowPath}": must export a WorkflowConfig with id and run`,
    );
  }

  cachedWorkflow = config;
  return config;
}

// ---------------------------------------------------------------------------
// Workflow execution
// ---------------------------------------------------------------------------

async function executeWorkflow(payload: unknown): Promise<WorkflowResult> {
  const start = Date.now();
  try {
    const workflow = await loadWorkflow();
    const ctx = createWorkflowContext({
      runtime: {
        workflowId: workflow.id,
        deploymentId: process.env.GTMSHIP_DEPLOYMENT_ID,
        executionId: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      },
      // runtimeAuth is auto-resolved from GTMSHIP_* env vars by
      // resolveRuntimeAuthOptions() inside auth.ts — no explicit config needed.
    });

    const data = await workflow.run(payload, ctx);
    return {
      success: true,
      data,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[gtmship-runner] Workflow execution failed:", message);
    return {
      success: false,
      error: message,
      duration_ms: Date.now() - start,
    };
  }
}

async function writeResultFileIfRequested(
  result: WorkflowResult
): Promise<void> {
  const resultPath = process.env.GTMSHIP_RESULT_PATH;
  if (!resultPath) {
    return;
  }

  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(
      "[gtmship-runner] Failed to persist workflow result:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ---------------------------------------------------------------------------
// AWS Lambda handler
// ---------------------------------------------------------------------------

interface LambdaEvent {
  requestContext?: { http?: { method?: string } };
  source?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  detail?: unknown;
  headers?: Record<string, string>;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const jsonHeaders = { "Content-Type": "application/json" };

  let payload: unknown;

  if (event.requestContext) {
    // API Gateway v2 event (webhook trigger)
    try {
      payload = event.body ? JSON.parse(event.body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }
  } else if (event.source === "aws.scheduler" || event.source === "aws.events") {
    // EventBridge Scheduler / CloudWatch Events (schedule trigger)
    payload = event.detail ?? tryParseJson(process.env.GTMSHIP_JOB_PAYLOAD) ?? {};
  } else {
    // Direct invocation or unknown source
    payload = event;
  }

  const result = await executeWorkflow(payload);

  return {
    statusCode: result.success ? 200 : 500,
    headers: jsonHeaders,
    body: JSON.stringify(result),
  };
}

// ---------------------------------------------------------------------------
// GCP Cloud Run Service — HTTP server
// ---------------------------------------------------------------------------

export async function startHttpServer(): Promise<void> {
  const { createServer } = await import("node:http");

  const port = parseInt(process.env.PORT || "8080", 10);

  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Workflow execution — accept POST on any path
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        let payload: unknown;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        const result = await executeWorkflow(payload);
        res.writeHead(result.success ? 200 : 500, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  });

  server.listen(port, () => {
    console.log(`[gtmship-runner] Listening on port ${port}`);
  });
}

function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// GCP Cloud Run Job — run once and exit
// ---------------------------------------------------------------------------

export async function runJob(): Promise<void> {
  const payload = tryParseJson(process.env.GTMSHIP_JOB_PAYLOAD) ?? {};
  const result = await executeWorkflow(payload);
  await writeResultFileIfRequested(result);

  if (result.success) {
    console.log(
      `[gtmship-runner] Job completed successfully in ${result.duration_ms}ms`,
    );
    process.exitCode = 0;
    return;
  } else {
    console.error(
      `[gtmship-runner] Job failed in ${result.duration_ms}ms: ${result.error}`,
    );
    process.exitCode = 1;
    return;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Auto-start based on runtime mode
// ---------------------------------------------------------------------------

const mode = process.env.GTMSHIP_RUNTIME_MODE;
if (mode === "cloud-run-service") {
  console.log("[gtmship-runner] Starting Cloud Run service");
  void startHttpServer();
} else if (mode === "cloud-run-job" || mode === "local-job") {
  console.log(
    `[gtmship-runner] Starting ${mode} for workflow ${process.env.GTMSHIP_WORKFLOW_ID || "unknown"}`,
  );
  void runJob();
}
// Lambda: handler is imported by name by the Lambda runtime — no auto-start.
