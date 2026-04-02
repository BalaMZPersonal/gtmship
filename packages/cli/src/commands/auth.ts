import chalk from "chalk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export async function authCommand(provider: string) {
  console.log(chalk.blue(`\n🔗 Adding connection: ${provider}\n`));

  // Check for pre-built template
  const templatesDir = join(import.meta.dirname, "../../../../templates/connections");
  const templateFile = join(templatesDir, `${provider}.yaml`);

  if (existsSync(templateFile)) {
    console.log(chalk.green(`  ✓ Found pre-built template for ${provider}`));
    const template = readFileSync(templateFile, "utf8");
    console.log(chalk.gray(`\n${template}`));
  } else {
    const available = readdirSync(templatesDir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(".yaml", ""));
    console.log(
      chalk.yellow(
        `  No pre-built template for "${provider}". Available: ${available.join(", ")}`
      )
    );
    console.log(
      chalk.gray(
        `  Use the dashboard's AI chat to set up a custom connection.`
      )
    );
  }

  // TODO: Interactive prompts for client_id, client_secret, scopes
  // Then register with auth service via API
  console.log(
    chalk.blue(`\n  To complete setup, open the dashboard:
    http://localhost:3000/connections
  `)
  );
}
