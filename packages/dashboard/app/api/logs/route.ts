import { NextResponse } from "next/server";
import { resolveCliInvocation } from "@/lib/runtime/cli";

interface StructuredLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const CLI_LOG_PATTERN =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\[(INFO|WARN|WARNING|ERROR)\]\s+(?:\[([^\]]+)\]\s+)?(.+)$/i;

function toLevel(
  value: string
): "info" | "warn" | "error" {
  const normalized = value.toUpperCase();
  if (normalized === "ERROR") {
    return "error";
  }
  if (normalized === "WARN" || normalized === "WARNING") {
    return "warn";
  }
  return "info";
}

function parseStructuredEntry(line: string): StructuredLogEntry | null {
  const stripped = line.replace(ANSI_PATTERN, "").trim();
  if (!stripped) {
    return null;
  }

  const match = stripped.match(CLI_LOG_PATTERN);
  if (!match) {
    return null;
  }

  const [, timestamp, level, workflowTag, message] = match;
  return {
    timestamp,
    level: toLevel(level),
    message: workflowTag ? `[${workflowTag}] ${message}` : message,
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") || "aws";
  const since = searchParams.get("since") || "1h";
  const limit = searchParams.get("limit") || "200";
  const workflowId = searchParams.get("workflow") || "";

  // Fetch logs via CLI subprocess to avoid bundling Pulumi/native deps
  const { spawn } = await import("node:child_process");
  const cliInvocation = resolveCliInvocation();

  const args = ["logs", "--provider", provider, "--since", since, "--limit", limit];
  if (workflowId) args.push("--workflow", workflowId);

  return new Promise<NextResponse>((resolve) => {
    const output: string[] = [];
    const child = spawn(cliInvocation.command, [...cliInvocation.baseArgs, ...args], {
      cwd: process.env.PROJECT_ROOT || process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data: Buffer) => output.push(data.toString()));
    child.stderr.on("data", (data: Buffer) => output.push(data.toString()));

    child.on("close", (code) => {
      const raw = output.join("");
      const entries = raw
        .split("\n")
        .map(parseStructuredEntry)
        .filter((entry): entry is StructuredLogEntry => Boolean(entry));

      if (code === 0) {
        resolve(NextResponse.json({ entries, logs: entries, raw }));
        return;
      }

      resolve(
        NextResponse.json(
          {
            error: "Failed to fetch logs.",
            entries,
            logs: entries,
            raw,
          },
          { status: 500 }
        )
      );
    });

    child.on("error", (err) => {
      resolve(
        NextResponse.json(
          {
            error: `Failed to fetch logs: ${err.message}`,
            entries: [],
            logs: [],
          },
          { status: 500 },
        ),
      );
    });
  });
}
