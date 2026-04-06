import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { listLocalLogEntries } from "../lib/local-deployments.js";

interface LogsOptions {
  workflow?: string;
  provider?: string;
  follow?: boolean;
  since: string;
  limit: string;
}

const LEVEL_COLORS: Record<string, (s: string) => string> = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.gray,
};

function readConfigProvider(): { provider: string; gcpProject?: string } {
  const configPath = join(process.cwd(), "gtmship.config.yaml");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as {
      deploy?: { provider?: string; gcp_project?: string };
      name?: string;
    };
    return {
      provider: config.deploy?.provider || "aws",
      gcpProject: config.deploy?.gcp_project,
    };
  }
  return { provider: "aws" };
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export async function logsCommand(options: LogsOptions) {
  const configDefaults = readConfigProvider();
  const provider = (options.provider || configDefaults.provider) as
    | "aws"
    | "gcp"
    | "local";
  const limit = parseInt(options.limit, 10) || 100;

  console.log(
    chalk.blue(
      `\n  Fetching logs from ${provider.toUpperCase()}...\n`,
    ),
  );

  try {
    const { parseDuration } = await import("@gtmship/deploy-engine/logs");

    if (provider === "local") {
      const startTime = parseDuration(options.since);
      const entries = listLocalLogEntries({
        workflowId: options.workflow,
        startTime,
        limit,
      });

      if (entries.length === 0) {
        console.log(chalk.yellow("  No local logs found for the given filters."));
        return;
      }

      for (const entry of entries) {
        const ts = formatTimestamp(entry.timestamp);
        const colorize = LEVEL_COLORS[entry.level] || chalk.gray;
        const levelTag = colorize(`[${entry.level.toUpperCase()}]`.padEnd(7));
        const wfTag = entry.workflowId
          ? chalk.cyan(`[${entry.workflowId}] `)
          : "";
        console.log(`  ${chalk.gray(ts)} ${levelTag} ${wfTag}${entry.message}`);
      }

      console.log(chalk.gray(`\n  ${entries.length} local log entries shown.`));
      return;
    }

    const { fetchLogs, streamLogs } = await import(
      "@gtmship/deploy-engine/logs"
    );
    const startTime = parseDuration(options.since);

    const configPath = join(process.cwd(), "gtmship.config.yaml");
    let projectName = "gtmship";
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const config = parseYaml(raw) as { name?: string };
      projectName = config.name || "gtmship";
    }

    const query = {
      provider,
      projectName,
      workflowId: options.workflow,
      startTime,
      limit,
      gcpProject: configDefaults.gcpProject,
    };

    if (options.follow) {
      console.log(chalk.gray("  Streaming logs (Ctrl+C to stop)...\n"));

      const { stop } = await streamLogs(
        query,
        (entry: { timestamp: Date; level: string; message: string; workflowId?: string }) => {
          const ts = formatTimestamp(entry.timestamp);
          const colorize = LEVEL_COLORS[entry.level] || chalk.gray;
          const levelTag = colorize(
            `[${entry.level.toUpperCase()}]`.padEnd(7),
          );
          const wfTag = entry.workflowId
            ? chalk.cyan(`[${entry.workflowId}] `)
            : "";
          console.log(
            `  ${chalk.gray(ts)} ${levelTag} ${wfTag}${entry.message}`,
          );
        },
      );

      // Handle graceful shutdown
      process.on("SIGINT", () => {
        stop();
        console.log(chalk.gray("\n  Stopped streaming."));
        process.exit(0);
      });
    } else {
      const result = await fetchLogs(query);

      if (result.entries.length === 0) {
        console.log(chalk.yellow("  No logs found for the given filters."));
        return;
      }

      for (const entry of result.entries) {
        const ts = formatTimestamp(entry.timestamp);
        const colorize = LEVEL_COLORS[entry.level] || chalk.gray;
        const levelTag = colorize(
          `[${entry.level.toUpperCase()}]`.padEnd(7),
        );
        const wfTag = entry.workflowId
          ? chalk.cyan(`[${entry.workflowId}] `)
          : "";
        console.log(
          `  ${chalk.gray(ts)} ${levelTag} ${wfTag}${entry.message}`,
        );
      }

      if (result.nextToken) {
        console.log(
          chalk.gray(`\n  More logs available. Use --limit to increase.`),
        );
      }

      console.log(
        chalk.gray(`\n  ${result.entries.length} log entries shown.`),
      );
    }
  } catch (err) {
    console.log(
      chalk.red(
        `\n  Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
}
