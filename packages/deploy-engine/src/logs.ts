/**
 * Unified Logging Abstraction
 *
 * Provides a single interface for fetching execution logs from deployed
 * workflows on either AWS (CloudWatch Logs) or GCP (Cloud Logging).
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { Logging } from "@google-cloud/logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogQuery {
  provider: "aws" | "gcp";
  projectName: string;
  workflowId?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  nextToken?: string;
  // AWS-specific
  awsRegion?: string;
  // GCP-specific
  gcpProject?: string;
  gcpTargetKind?: GcpLogTargetKind;
  gcpComputeName?: string;
  gcpExecutionName?: string;
}

export type GcpLogTargetKind = "service" | "job";

export interface LogEntry {
  timestamp: Date;
  message: string;
  level: "info" | "warn" | "error";
  workflowId?: string;
  requestId?: string;
}

export interface LogResult {
  entries: LogEntry[];
  nextToken?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AWS_LOG_GROUP = "/aws/lambda/gtmship-worker";
const DEFAULT_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch logs from the specified cloud provider.
 */
export async function fetchLogs(query: LogQuery): Promise<LogResult> {
  switch (query.provider) {
    case "aws":
      return fetchAwsLogs(query);
    case "gcp":
      return fetchGcpLogs(query);
    default:
      throw new Error(
        `Unsupported log provider: ${(query as LogQuery).provider}`,
      );
  }
}

/**
 * Poll for new logs at a regular interval.
 *
 * Returns a handle with a `stop()` method to cancel polling.
 * Tracks the last-seen timestamp to avoid delivering duplicates.
 */
export async function streamLogs(
  query: LogQuery,
  onEntry: (entry: LogEntry) => void,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<{ stop: () => void }> {
  let running = true;
  let lastTimestamp = query.startTime ?? new Date();

  const poll = async () => {
    while (running) {
      try {
        const result = await fetchLogs({
          ...query,
          startTime: lastTimestamp,
          nextToken: undefined,
        });

        for (const entry of result.entries) {
          // Skip entries at or before the last-seen timestamp to avoid dupes
          if (entry.timestamp.getTime() > lastTimestamp.getTime()) {
            onEntry(entry);
          }
        }

        if (result.entries.length > 0) {
          const maxTs = Math.max(
            ...result.entries.map((e) => e.timestamp.getTime()),
          );
          lastTimestamp = new Date(maxTs);
        }
      } catch (err) {
        // Log polling errors but keep going
        console.error("Log polling error:", err);
      }

      if (running) {
        await sleep(intervalMs);
      }
    }
  };

  // Fire-and-forget the poll loop
  poll();

  return {
    stop: () => {
      running = false;
    },
  };
}

/**
 * Parse a human-readable duration string (e.g. "1h", "30m", "7d") into a
 * Date in the past relative to now.
 */
export function parseDuration(since: string): Date {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration "${since}". Expected format: 30s, 15m, 1h, or 7d`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = Date.now();
  let ms: number;

  switch (unit) {
    case "s":
      ms = value * 1000;
      break;
    case "m":
      ms = value * 60 * 1000;
      break;
    case "h":
      ms = value * 60 * 60 * 1000;
      break;
    case "d":
      ms = value * 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }

  return new Date(now - ms);
}

// ---------------------------------------------------------------------------
// AWS — CloudWatch Logs
// ---------------------------------------------------------------------------

async function fetchAwsLogs(query: LogQuery): Promise<LogResult> {
  const client = new CloudWatchLogsClient({
    region: query.awsRegion ?? "us-east-1",
  });

  const filterPattern = query.workflowId
    ? `"${query.workflowId}"`
    : undefined;

  const command = new FilterLogEventsCommand({
    logGroupName: AWS_LOG_GROUP,
    filterPattern,
    startTime: query.startTime?.getTime(),
    endTime: query.endTime?.getTime(),
    limit: query.limit ?? DEFAULT_LIMIT,
    nextToken: query.nextToken,
  });

  const response = await client.send(command);

  const entries: LogEntry[] = (response.events ?? []).map(
    (event: FilteredLogEvent) => mapAwsEvent(event, query.workflowId),
  );

  return {
    entries,
    nextToken: response.nextToken ?? undefined,
  };
}

function mapAwsEvent(
  event: FilteredLogEvent,
  workflowId?: string,
): LogEntry {
  const message = event.message?.trim() ?? "";
  const timestamp = new Date(event.timestamp ?? Date.now());

  // Attempt to extract requestId from the CloudWatch message format.
  // Lambda log lines typically start with: "2024-01-01T00:00:00.000Z <requestId> ..."
  let requestId: string | undefined;
  const requestIdMatch = message.match(
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+([0-9a-f-]{36})/,
  );
  if (requestIdMatch) {
    requestId = requestIdMatch[1];
  } else if (event.eventId) {
    requestId = event.eventId;
  }

  return {
    timestamp,
    message,
    level: parseLogLevel(message),
    workflowId,
    requestId,
  };
}

// ---------------------------------------------------------------------------
// GCP — Cloud Logging
// ---------------------------------------------------------------------------

async function fetchGcpLogs(query: LogQuery): Promise<LogResult> {
  if (!query.gcpProject) {
    throw new Error("gcpProject is required to fetch GCP logs.");
  }

  const logging = new Logging({
    projectId: query.gcpProject,
  });

  const targetKinds: GcpLogTargetKind[] = query.gcpTargetKind
    ? [query.gcpTargetKind]
    : ["job", "service"];

  const perTargetResults = await Promise.all(
    targetKinds.map((targetKind) =>
      fetchGcpLogsForTarget(logging, query, targetKind),
    ),
  );

  const merged = perTargetResults
    .flatMap((result) => result.entries)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

  const limit = query.limit ?? DEFAULT_LIMIT;
  const entries =
    merged.length > limit ? merged.slice(merged.length - limit) : merged;

  if (targetKinds.length === 1) {
    return {
      entries,
      nextToken: perTargetResults[0]?.nextToken,
    };
  }

  return {
    entries,
    nextToken: undefined,
  };
}

export function buildGcpLogFilter(input: {
  targetKind: GcpLogTargetKind;
  computeName?: string;
  executionName?: string;
  workflowId?: string;
  startTime?: Date;
  endTime?: Date;
}): string {
  const resourceType =
    input.targetKind === "job" ? "cloud_run_job" : "cloud_run_revision";
  const resourceLabelKey =
    input.targetKind === "job" ? "job_name" : "service_name";
  const filterParts: string[] = [
    `resource.type="${resourceType}"`,
  ];

  const computeName = input.computeName?.trim();
  if (computeName) {
    filterParts.push(
      `resource.labels.${resourceLabelKey}="${escapeLoggingFilterValue(computeName)}"`,
    );
  }

  if (input.startTime) {
    filterParts.push(`timestamp>="${input.startTime.toISOString()}"`);
  }
  if (input.endTime) {
    filterParts.push(`timestamp<="${input.endTime.toISOString()}"`);
  }
  if (input.workflowId?.trim()) {
    const workflowId = input.workflowId.trim();
    filterParts.push(
      `(textPayload=~"${escapeLoggingRegex(workflowId)}" OR jsonPayload.workflowId="${escapeLoggingFilterValue(workflowId)}")`,
    );
  }

  if (input.executionName?.trim()) {
    const executionName = escapeLoggingFilterValue(input.executionName.trim());
    filterParts.push(
      `(labels."run.googleapis.com/execution_name"="${executionName}" OR resource.labels.execution_name="${executionName}")`,
    );
  }

  return filterParts.join(" AND ");
}

async function fetchGcpLogsForTarget(
  logging: Logging,
  query: LogQuery,
  targetKind: GcpLogTargetKind,
): Promise<LogResult> {
  const filter = buildGcpLogFilter({
    targetKind,
    computeName: query.gcpComputeName,
    executionName: query.gcpExecutionName,
    workflowId: query.workflowId,
    startTime: query.startTime,
    endTime: query.endTime,
  });

  const [logEntries, , response] = await logging.getEntries({
    filter,
    pageSize: query.limit ?? DEFAULT_LIMIT,
    pageToken: query.nextToken,
    orderBy: "timestamp asc",
  });

  const entries: LogEntry[] = logEntries.map((entry: any) =>
    mapGcpEntry(entry, query.workflowId),
  );

  return {
    entries,
    nextToken: response?.nextPageToken ?? undefined,
  };
}

function mapGcpEntry(entry: any, workflowId?: string): LogEntry {
  const metadata = entry.metadata ?? {};
  const timestamp = metadata.timestamp
    ? new Date(metadata.timestamp)
    : new Date();

  // Prefer textPayload, fall back to jsonPayload message, then stringify
  let message: string;
  if (entry.data && typeof entry.data === "string") {
    message = entry.data;
  } else if (entry.data?.message) {
    message = entry.data.message;
  } else if (entry.data) {
    message = JSON.stringify(entry.data);
  } else {
    message = "";
  }

  // Map GCP severity to our level enum
  const severity = (metadata.severity ?? "INFO").toUpperCase();
  let level: "info" | "warn" | "error";
  if (severity === "ERROR" || severity === "CRITICAL" || severity === "ALERT" || severity === "EMERGENCY") {
    level = "error";
  } else if (severity === "WARNING") {
    level = "warn";
  } else {
    level = "info";
  }

  return {
    timestamp,
    message,
    level,
    workflowId,
    requestId: metadata.trace ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the log level from a message string by looking for common patterns.
 * Defaults to "info" when no recognizable pattern is found.
 */
function parseLogLevel(message: string): "info" | "warn" | "error" {
  // Check for ERROR-level patterns first (most important)
  if (/\bERROR\b/i.test(message) || /\bFATAL\b/i.test(message)) {
    return "error";
  }
  if (/\bWARN(?:ING)?\b/i.test(message)) {
    return "warn";
  }
  return "info";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeLoggingFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeLoggingRegex(value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escapeLoggingFilterValue(escaped);
}
