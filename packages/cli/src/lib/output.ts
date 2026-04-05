import chalk from "chalk";

export interface OutputOptions {
  json?: boolean;
}

export function formatOutput(
  data: unknown,
  opts: OutputOptions,
  humanRenderer: () => void,
): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanRenderer();
  }
}

export function printTable(
  rows: Record<string, string>[],
  columns: { key: string; label: string }[],
): void {
  if (rows.length === 0) {
    console.log(chalk.yellow("  No results found."));
    return;
  }

  const widths = columns.map((col) =>
    Math.max(
      col.label.length,
      ...rows.map((row) => (row[col.key] || "").length),
    ),
  );

  const header = columns
    .map((col, i) => col.label.padEnd(widths[i]))
    .join("  ");
  console.log(chalk.bold(`  ${header}`));
  console.log(chalk.gray(`  ${"─".repeat(header.length)}`));

  for (const row of rows) {
    const line = columns
      .map((col, i) => (row[col.key] || "").padEnd(widths[i]))
      .join("  ");
    console.log(`  ${line}`);
  }
}

export function printDetail(label: string, value: string | undefined | null): void {
  console.log(chalk.white(`  ${label}: ${chalk.cyan(value || "—")}`));
}

export function printSuccess(message: string): void {
  console.log(chalk.green(`  ${message}`));
}

export function printError(message: string): void {
  console.log(chalk.red(`  ${message}`));
}

export function printWarning(message: string): void {
  console.log(chalk.yellow(`  ${message}`));
}

export function handleError(err: unknown, opts: OutputOptions): void {
  if (opts.json) {
    const status = (err as Error & { status?: number }).status;
    console.log(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        ...(status ? { status } : {}),
      }),
    );
  } else {
    printError(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(1);
}

export async function confirmAction(
  message: string,
  opts: { force?: boolean; json?: boolean },
): Promise<boolean> {
  if (opts.force || opts.json) {
    return true;
  }
  const { default: inquirer } = await import("inquirer");
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: false,
    },
  ]);
  return confirmed;
}
