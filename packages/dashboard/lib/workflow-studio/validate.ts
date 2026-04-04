import {
  compileWorkflowSource,
  detectWorkflowMode,
  loadWorkflowDefinitionFromSource,
} from "./runtime";
import type {
  WorkflowStudioArtifact,
  WorkflowValidationIssue,
  WorkflowValidationReport,
} from "./types";

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["'](?:node:)?fs["']/,
  /from\s+["'](?:node:)?child_process["']/,
  /from\s+["'](?:node:)?net["']/,
  /from\s+["'](?:node:)?tls["']/,
  /from\s+["'](?:node:)?dns["']/,
  /require\(\s*["'](?:node:)?fs["']\s*\)/,
  /require\(\s*["'](?:node:)?child_process["']\s*\)/,
  /require\(\s*["']axios["']\s*\)/,
];

const STUDIO_ONLY_FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  message: string;
}> = [
  { pattern: /\bfetch\s*\(/, message: "Use ctx.web.read/write instead of raw fetch." },
  {
    pattern: /\bauth\.getClient\s*\(/,
    message: "Use ctx.integration(...) instead of auth.getClient(...).",
  },
  {
    pattern: /\bauth\.getToken\s*\(/,
    message: "Use ctx.integration(...) helpers instead of raw tokens.",
  },
  {
    pattern: /\baxios\b/,
    message: "Use WorkflowContext network helpers instead of axios.",
  },
  {
    pattern: /\bprocess\.env\b/,
    message: "Generated workflows must not read process.env directly.",
  },
];

function createIssue(
  level: "error" | "warning",
  message: string
): WorkflowValidationIssue {
  return { level, message };
}

function detectWriteCheckpoints(source: string): string[] {
  return Array.from(
    source.matchAll(/checkpoint\s*:\s*["'`]([^"'`]+)["'`]/g)
  ).map((match) => match[1]);
}

function extractBalancedWriteCall(source: string, startIndex: number): string | null {
  // Find the opening paren after .write
  let i = startIndex;
  while (i < source.length && source[i] !== "(") i++;
  if (i >= source.length) return null;

  let depth = 0;
  const begin = startIndex;
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(begin, i + 1);
    }
  }
  return null;
}

function detectMissingWriteCheckpointErrors(source: string): string[] {
  const errors: string[] = [];
  const writeCallPattern = /\.write\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = writeCallPattern.exec(source)) !== null) {
    const snippet = extractBalancedWriteCall(source, match.index);
    if (snippet && !/checkpoint\s*:/.test(snippet)) {
      errors.push("Every ctx.*.write(...) call must include a checkpoint.");
    }
  }

  return errors;
}

function detectAbsoluteIntegrationUrlErrors(source: string): string[] {
  const matches = Array.from(
    source.matchAll(
      /([a-zA-Z_$][\w$]*)\.(read|write)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g
    )
  );

  return matches
    .filter(([_, objectName]) => objectName !== "web")
    .map(
      ([, objectName, method, url]) =>
        `${objectName}.${method}(...) must use a provider-relative path, not a full URL: ${url}`
    );
}

function detectMissingDeployLoggingErrors(source: string): string[] {
  const logMatches = source.match(/\bconsole\.log\s*\(/g) || [];
  const errorMatches = source.match(/\bconsole\.error\s*\(/g) || [];
  const hasTryCatch = /\btry\s*\{[\s\S]*\}\s*catch\s*\(/.test(source);
  const issues: string[] = [];

  if (logMatches.length < 2) {
    issues.push(
      "Generated workflows must include deploy-visible console.log statements for start and completion."
    );
  }

  if (!hasTryCatch) {
    issues.push(
      "Generated workflows must wrap run logic in try/catch so deployment logs capture failures."
    );
  }

  if (errorMatches.length < 1) {
    issues.push(
      "Generated workflows must log failures with console.error so deployed errors are visible."
    );
  }

  return issues;
}

function buildRuntimeSdkStub() {
  return {
    defineWorkflow<T>(config: T): T {
      return config;
    },
    triggers: {
      manual() {
        return { type: "manual" as const };
      },
      webhook(path: string) {
        return { type: "webhook" as const, path };
      },
      schedule(cron: string) {
        return { type: "schedule" as const, cron };
      },
      event(eventName: string) {
        return { type: "event" as const, event: eventName };
      },
    },
    auth: {
      getClient() {
        throw new Error("auth.getClient() is not available in validation mode.");
      },
      getToken() {
        throw new Error("auth.getToken() is not available in validation mode.");
      },
    },
  };
}

export function validateWorkflowArtifact(
  artifact: Pick<
    WorkflowStudioArtifact,
    "code" | "slug" | "writeCheckpoints"
  >
): WorkflowValidationReport {
  const mode = detectWorkflowMode(artifact.code);
  const issues: WorkflowValidationIssue[] = [];
  const forbiddenPatterns: string[] = [];
  const compile = compileWorkflowSource(artifact.code, `${artifact.slug}.ts`);

  if (compile.diagnostics.length > 0) {
    issues.push(
      ...compile.diagnostics.map((message) => createIssue("error", message))
    );
  }

  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (pattern.test(artifact.code)) {
      const message = `Forbidden module usage detected: ${pattern}`;
      forbiddenPatterns.push(message);
      issues.push(createIssue("error", message));
    }
  }

  if (mode === "studio") {
    for (const rule of STUDIO_ONLY_FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(artifact.code)) {
        forbiddenPatterns.push(rule.message);
        issues.push(createIssue("error", rule.message));
      }
    }

    for (const error of detectMissingWriteCheckpointErrors(artifact.code)) {
      issues.push(createIssue("error", error));
    }

    for (const error of detectAbsoluteIntegrationUrlErrors(artifact.code)) {
      issues.push(createIssue("error", error));
    }

    for (const error of detectMissingDeployLoggingErrors(artifact.code)) {
      issues.push(createIssue("error", error));
    }
  }

  let workflowDefinition:
    | {
        id?: string;
        name?: string;
        trigger?: { type?: string };
        deploy?: Record<string, unknown>;
        run?: unknown;
      }
    | undefined;

  try {
    workflowDefinition = loadWorkflowDefinitionFromSource<{
      id?: string;
      name?: string;
      trigger?: { type?: string };
      deploy?: Record<string, unknown>;
      run?: unknown;
    }>(artifact.code, buildRuntimeSdkStub(), `${artifact.slug}.ts`);
  } catch (error) {
    issues.push(
      createIssue(
        "error",
        error instanceof Error ? error.message : "Failed to evaluate workflow."
      )
    );
  }

  if (!workflowDefinition || typeof workflowDefinition !== "object") {
    issues.push(
      createIssue("error", "Workflow must export a default defineWorkflow(...) object.")
    );
  } else {
    if (!workflowDefinition.id) {
      issues.push(createIssue("error", "Workflow must define an id."));
    }
    if (!workflowDefinition.trigger?.type) {
      issues.push(createIssue("error", "Workflow must define a trigger."));
    }
    if (typeof workflowDefinition.run !== "function") {
      issues.push(createIssue("error", "Workflow must define an async run function."));
    }
  }

  const detectedWriteCheckpoints = detectWriteCheckpoints(artifact.code);
  for (const checkpoint of artifact.writeCheckpoints) {
    if (!detectedWriteCheckpoints.includes(checkpoint.id)) {
      issues.push(
        createIssue(
          "error",
          `Write checkpoint "${checkpoint.id}" is declared in metadata but missing in code.`
        )
      );
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    details: {
      mode,
      workflowId: workflowDefinition?.id,
      workflowName: workflowDefinition?.name,
      triggerType: workflowDefinition?.trigger?.type,
      usesContext:
        /\brun\s*\(\s*[^,)]+,\s*[a-zA-Z_$][\w$]*/.test(artifact.code) ||
        /\bctx\./.test(artifact.code),
      forbiddenPatterns,
      detectedWriteCheckpoints,
    },
  };
}
