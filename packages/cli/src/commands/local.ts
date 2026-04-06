import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import {
  dispatchLocalWorkflows,
  runLocalWorkflow,
} from "../lib/local-deployments.js";
import { formatOutput, type OutputOptions } from "../lib/output.js";

interface LocalRunOptions extends OutputOptions {
  payload?: string;
}

function parsePayload(raw?: string): unknown {
  if (!raw) {
    return undefined;
  }

  const candidate = raw.trim();
  const value = existsSync(candidate) ? readFileSync(candidate, "utf8") : candidate;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      "Local workflow payload must be valid JSON or a path to a JSON file."
    );
  }
}

export async function localDispatchCommand(): Promise<void> {
  const result = await dispatchLocalWorkflows();
  console.log(chalk.blue("\n  Local Workflow Dispatch\n"));
  console.log(chalk.gray(`  Checked:    ${result.checked}`));
  console.log(chalk.gray(`  Dispatched: ${result.dispatched}`));
  console.log("");
}

export async function localRunCommand(
  workflowId: string,
  options: LocalRunOptions
): Promise<void> {
  const payload = parsePayload(options.payload);
  const result = await runLocalWorkflow({
    workflowId,
    payload,
    triggerSource: "manual",
  });

  formatOutput(result, options, () => {
    if (!result.success) {
      console.log(
        chalk.red(
          `\n  Local workflow run failed: ${result.error || "Unknown error"}`
        )
      );
      if (result.executionId) {
        console.log(chalk.gray(`  Execution: ${result.executionId}`));
      }
      process.exit(1);
    }

    console.log(
      chalk.green(`\n  Local workflow ${workflowId} completed successfully.`)
    );
    if (result.executionId) {
      console.log(chalk.gray(`  Execution: ${result.executionId}`));
    }
    if (result.runId) {
      console.log(chalk.gray(`  Run ID:    ${result.runId}`));
    }
    if (result.output !== undefined) {
      console.log("");
      console.log(
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output, null, 2)
      );
      console.log("");
    }
  });

  if (!result.success) {
    process.exit(1);
  }
}
