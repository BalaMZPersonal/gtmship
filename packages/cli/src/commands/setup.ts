import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api-client.js";
import {
  formatOutput,
  handleError,
  printDetail,
  printSuccess,
  printWarning,
  type OutputOptions,
} from "../lib/output.js";

type SetupStepId =
  | "ai"
  | "cloud"
  | "secret_storage"
  | "workspace"
  | "oauth_apps";
type SetupStepStatus = "complete" | "incomplete" | "skipped" | "blocked";
type CloudProvider = "aws" | "gcp";
type CloudMode = "stored" | "environment" | "later";

interface SetupStatusResponse {
  overallStatus: "complete" | "incomplete";
  dismissed: boolean;
  progress: {
    completed: number;
    total: number;
  };
  steps: Array<{
    id: SetupStepId;
    title: string;
    optional: boolean;
    status: SetupStepStatus;
    summary: string;
    missing: string[];
    blockedBy: string[];
  }>;
  preferences: {
    version: 1;
    dismissedAt?: string | null;
    steps?: Partial<Record<SetupStepId, { skipped?: boolean; choice?: string }>>;
  };
}

interface SettingsRecord {
  key: string;
  value: string;
}

interface OAuthProviderResponse {
  key: string;
  name: string;
  redirect_uri: string;
  has_credentials: boolean;
}

interface ModelLookupResponse {
  models: Array<{
    id: string;
    displayName: string;
  }>;
}

function formatStepStatus(status: SetupStepStatus): string {
  switch (status) {
    case "complete":
      return chalk.green("complete");
    case "skipped":
      return chalk.gray("skipped");
    case "blocked":
      return chalk.red("blocked");
    default:
      return chalk.yellow("incomplete");
  }
}

async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return apiGet("/setup") as Promise<SetupStatusResponse>;
}

async function updateSetupState(input: {
  dismissed?: boolean;
  steps?: Partial<Record<SetupStepId, { skipped?: boolean; choice?: string }>>;
}): Promise<SetupStatusResponse> {
  return apiPut("/setup", input) as Promise<SetupStatusResponse>;
}

async function fetchSettings(): Promise<SettingsRecord[]> {
  return apiGet("/settings") as Promise<SettingsRecord[]>;
}

async function fetchGoogleOAuthProvider(): Promise<OAuthProviderResponse | null> {
  try {
    return (await apiGet("/oauth-providers/google")) as OAuthProviderResponse;
  } catch {
    return null;
  }
}

async function searchAiModels(input: {
  provider: "claude" | "openai";
  apiKey: string;
  query?: string;
}): Promise<ModelLookupResponse> {
  return apiPost("/ai/models", input) as Promise<ModelLookupResponse>;
}

function getSettingValue(
  settings: SettingsRecord[],
  key: string
): string {
  return settings.find((setting) => setting.key === key)?.value || "";
}

function hasStoredSetting(settings: SettingsRecord[], key: string): boolean {
  return Boolean(getSettingValue(settings, key));
}

function resolveCloudProvider(
  settings: SettingsRecord[],
  status: SetupStatusResponse
): CloudProvider {
  const cloudChoice = status.preferences.steps?.cloud?.choice || "";
  if (cloudChoice.endsWith(":gcp")) {
    return "gcp";
  }
  if (cloudChoice.endsWith(":aws")) {
    return "aws";
  }
  return getSettingValue(settings, "cloud_provider") === "gcp" ? "gcp" : "aws";
}

function resolveCurrentWorkspaceChoice(
  settings: SettingsRecord[],
  status: SetupStatusResponse
): "default" | "custom" | "later" {
  const choice = status.preferences.steps?.workspace?.choice;
  if (choice === "later") {
    return "later";
  }
  if (choice === "custom" || getSettingValue(settings, "project_root")) {
    return "custom";
  }
  return "default";
}

async function printSetupStatus(
  opts: OutputOptions
): Promise<void> {
  try {
    const status = await fetchSetupStatus();
    formatOutput(status, opts, () => {
      console.log("");
      printDetail("Overall", status.overallStatus);
      printDetail(
        "Progress",
        `${status.progress.completed}/${status.progress.total} steps ready`
      );
      printDetail("Dismissed", status.dismissed ? "yes" : "no");
      console.log("");

      for (const step of status.steps) {
        console.log(
          chalk.white(`  ${step.title}: ${formatStepStatus(step.status)}`)
        );
        console.log(chalk.gray(`    ${step.summary}`));
        if (step.missing.length > 0) {
          console.log(
            chalk.yellow(`    Missing: ${step.missing.join(", ")}`)
          );
        }
        if (step.blockedBy.length > 0) {
          console.log(
            chalk.red(`    Blocked by: ${step.blockedBy.join(" ")}`)
          );
        }
      }

      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export async function setupCommand(): Promise<void> {
  const { default: inquirer } = await import("inquirer");

  try {
    let status = await fetchSetupStatus();
    let settings = await fetchSettings();
    const googleOAuth = await fetchGoogleOAuthProvider();

    console.log(chalk.blue("\nGTMShip setup\n"));
    console.log(
      chalk.gray(
        `  ${status.progress.completed}/${status.progress.total} steps ready. This wizard is additive and will not change your existing flows unless you save new values.\n`
      )
    );

    const aiProviderDefault =
      getSettingValue(settings, "ai_provider") === "openai" ? "openai" : "claude";
    const { aiChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "aiChoice",
        message: "AI setup:",
        default:
          status.preferences.steps?.ai?.choice === "later" ? "later" : aiProviderDefault,
        choices: [
          { name: "Configure Claude", value: "claude" },
          { name: "Configure OpenAI", value: "openai" },
          { name: "Skip for now", value: "later" },
        ],
      },
    ]);

    if (aiChoice === "later") {
      status = await updateSetupState({
        dismissed: false,
        steps: { ai: { skipped: true, choice: "later" } },
      });
    } else {
      const provider = aiChoice as "claude" | "openai";
      const hasStoredKey = hasStoredSetting(
        settings,
        provider === "claude" ? "anthropic_api_key" : "openai_api_key"
      );
      const { apiKey } = await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message:
            provider === "claude" ? "Anthropic API key:" : "OpenAI API key:",
          mask: "*",
        },
      ]);

      const typedApiKey = (apiKey || "").trim();
      if (!typedApiKey && !hasStoredKey) {
        throw new Error(
          `A ${provider === "claude" ? "Claude" : "OpenAI"} API key is required unless one is already saved.`
        );
      }

      let selectedModel = "";
      try {
        const modelResponse = await searchAiModels({
          provider,
          apiKey: typedApiKey,
        });
        const models = modelResponse.models.slice(0, 20);
        const defaultModel =
          getSettingValue(
            settings,
            provider === "claude" ? "anthropic_model" : "openai_model"
          ) ||
          (provider === "claude" ? "claude-sonnet-4-6" : "gpt-4o");

        if (models.length > 0) {
          const answers = await inquirer.prompt([
            {
              type: "list",
              name: "modelId",
              message: "Default model:",
              default: defaultModel,
              choices: models.map((model) => ({
                name:
                  model.displayName === model.id
                    ? model.id
                    : `${model.displayName} (${model.id})`,
                value: model.id,
              })),
            },
          ]);
          selectedModel = answers.modelId;
        }
      } catch (error) {
        printWarning(
          error instanceof Error
            ? error.message
            : "Unable to load live models. GTMShip will keep the provider default."
        );
      }

      await apiPut("/settings/ai_provider", { value: provider });
      if (typedApiKey) {
        await apiPut(
          `/settings/${provider === "claude" ? "anthropic_api_key" : "openai_api_key"}`,
          { value: typedApiKey }
        );
      }
      if (selectedModel) {
        await apiPut(
          `/settings/${provider === "claude" ? "anthropic_model" : "openai_model"}`,
          { value: selectedModel }
        );
      }

      status = await updateSetupState({
        dismissed: false,
        steps: {
          ai: {
            skipped: false,
            choice: provider,
          },
        },
      });
      printSuccess("AI setup saved.");
    }

    settings = await fetchSettings();

    const inferredCloudProvider = resolveCloudProvider(settings, status);
    const { cloudProviderChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "cloudProviderChoice",
        message: "Primary cloud target:",
        default:
          status.preferences.steps?.cloud?.choice === "later"
            ? "later"
            : inferredCloudProvider,
        choices: [
          { name: "AWS", value: "aws" },
          { name: "Google Cloud", value: "gcp" },
          { name: "Skip for now", value: "later" },
        ],
      },
    ]);

    if (cloudProviderChoice === "later") {
      status = await updateSetupState({
        dismissed: false,
        steps: { cloud: { skipped: true, choice: "later" } },
      });
    } else {
      const provider = cloudProviderChoice as CloudProvider;
      const { cloudMode } = await inquirer.prompt([
        {
          type: "list",
          name: "cloudMode",
          message: "How should GTMShip handle cloud credentials?",
          default:
            (status.preferences.steps?.cloud?.choice || "").startsWith("environment:")
              ? "environment"
              : "stored",
          choices: [
            { name: "Store credentials in GTMShip", value: "stored" },
            { name: "Use environment/default provider credentials", value: "environment" },
            { name: "Skip for now", value: "later" },
          ],
        },
      ]);

      if (cloudMode === "later") {
        status = await updateSetupState({
          dismissed: false,
          steps: { cloud: { skipped: true, choice: "later" } },
        });
      } else if (provider === "aws") {
        const { region } = await inquirer.prompt([
          {
            type: "input",
            name: "region",
            message: "AWS region:",
            default: getSettingValue(settings, "aws_region") || "us-east-1",
          },
        ]);
        let accessKeyId = "";
        let secretAccessKey = "";

        if (cloudMode === "stored") {
          const credentialAnswers = await inquirer.prompt([
            {
              type: "input",
              name: "accessKeyId",
              message: "AWS access key ID:",
              default: getSettingValue(settings, "aws_access_key_id"),
            },
            {
              type: "password",
              name: "secretAccessKey",
              message: "AWS secret access key:",
              mask: "*",
            },
          ]);
          accessKeyId = credentialAnswers.accessKeyId;
          secretAccessKey = credentialAnswers.secretAccessKey;
        }

        await apiPut("/settings/cloud_provider", { value: "aws" });
        await apiPut("/settings/aws_region", { value: region.trim() || "us-east-1" });

        if (cloudMode === "stored") {
          if (!accessKeyId?.trim()) {
            throw new Error("AWS access key ID is required for stored credential mode.");
          }
          if (!secretAccessKey?.trim() && !hasStoredSetting(settings, "aws_secret_access_key")) {
            throw new Error("AWS secret access key is required for stored credential mode.");
          }

          await apiPut("/settings/aws_access_key_id", {
            value: accessKeyId.trim(),
          });
          if (secretAccessKey?.trim()) {
            await apiPut("/settings/aws_secret_access_key", {
              value: secretAccessKey.trim(),
            });
          }
        }

        status = await updateSetupState({
          dismissed: false,
          steps: {
            cloud: {
              skipped: false,
              choice: `${cloudMode}:aws`,
            },
          },
        });
      } else {
        const { projectId, region } = await inquirer.prompt([
          {
            type: "input",
            name: "projectId",
            message: "GCP project ID:",
            default: getSettingValue(settings, "gcp_project_id"),
          },
          {
            type: "input",
            name: "region",
            message: "GCP region:",
            default: getSettingValue(settings, "gcp_region") || "us-central1",
          },
        ]);
        let serviceAccountPath = "";

        if (cloudMode === "stored") {
          const credentialAnswers = await inquirer.prompt([
            {
              type: "input",
              name: "serviceAccountPath",
              message:
                "Path to the GCP service account JSON file (leave blank to keep the saved one):",
            },
          ]);
          serviceAccountPath = credentialAnswers.serviceAccountPath;
        }

        if (!projectId?.trim()) {
          throw new Error("GCP project ID is required for Google Cloud setup.");
        }

        await apiPut("/settings/cloud_provider", { value: "gcp" });
        await apiPut("/settings/gcp_project_id", { value: projectId.trim() });
        await apiPut("/settings/gcp_region", {
          value: region.trim() || "us-central1",
        });

        if (cloudMode === "stored") {
          const path = (serviceAccountPath || "").trim();
          if (!path && !hasStoredSetting(settings, "gcp_service_account_key")) {
            throw new Error("A GCP service account JSON file path is required for stored credential mode.");
          }
          if (path) {
            const resolvedPath = resolve(path);
            if (!existsSync(resolvedPath)) {
              throw new Error(`No file exists at ${resolvedPath}.`);
            }
            const contents = readFileSync(resolvedPath, "utf8");
            await apiPut("/settings/gcp_service_account_key", { value: contents });
          }
        }

        status = await updateSetupState({
          dismissed: false,
          steps: {
            cloud: {
              skipped: false,
              choice: `${cloudMode}:gcp`,
            },
          },
        });
      }

      printSuccess("Cloud setup saved.");
    }

    settings = await fetchSettings();

    const { secretStorageChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "secretStorageChoice",
        message: "Connection secret storage:",
        default: getSettingValue(settings, "connection_auth_mode") || "proxy",
        choices: [
          { name: "Proxy mode", value: "proxy" },
          { name: "Secret manager mode", value: "secret_manager" },
          { name: "Skip for now", value: "later" },
        ],
      },
    ]);

    if (secretStorageChoice === "later") {
      status = await updateSetupState({
        dismissed: false,
        steps: {
          secret_storage: {
            skipped: true,
            choice: "later",
          },
        },
      });
    } else {
      if (secretStorageChoice === "secret_manager") {
        const { prefix } = await inquirer.prompt([
          {
            type: "input",
            name: "prefix",
            message: "Optional secret prefix override:",
            default: getSettingValue(settings, "connection_secret_prefix"),
          },
        ]);
        if (prefix?.trim()) {
          await apiPut("/settings/connection_secret_prefix", {
            value: prefix.trim(),
          });
        }
      }

      await apiPut("/settings/auth-strategy", { mode: secretStorageChoice });
      status = await updateSetupState({
        dismissed: false,
        steps: {
          secret_storage: {
            skipped: false,
            choice: secretStorageChoice,
          },
        },
      });
      printSuccess("Secret storage preference saved.");
    }

    settings = await fetchSettings();

    const currentDirHasProject = existsSync(
      join(process.cwd(), "gtmship.config.yaml")
    );
    const { workspaceChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "workspaceChoice",
        message: "Workspace preference:",
        default: resolveCurrentWorkspaceChoice(settings, status),
        choices: [
          { name: "Use the default workspace", value: "default" },
          ...(currentDirHasProject
            ? [{ name: `Use the current directory (${process.cwd()})`, value: "current" }]
            : []),
          { name: "Use a custom path", value: "custom" },
          { name: "Skip for now", value: "later" },
        ],
      },
    ]);

    if (workspaceChoice === "later") {
      status = await updateSetupState({
        dismissed: false,
        steps: {
          workspace: {
            skipped: true,
            choice: "later",
          },
        },
      });
    } else if (workspaceChoice === "default") {
      try {
        await apiDelete("/settings/project_root");
      } catch {
        // It's fine if nothing was saved yet.
      }
      status = await updateSetupState({
        dismissed: false,
        steps: {
          workspace: {
            skipped: false,
            choice: "default",
          },
        },
      });
      printSuccess("Using the default workspace.");
    } else {
      const targetPath =
        workspaceChoice === "current"
          ? process.cwd()
          : (
              await inquirer.prompt([
                {
                  type: "input",
                  name: "customPath",
                  message: "Custom project root:",
                  default: getSettingValue(settings, "project_root"),
                },
              ])
            ).customPath;

      if (!targetPath?.trim()) {
        throw new Error("A project root is required for a custom workspace.");
      }

      await apiPut("/settings/project_root", {
        value: targetPath.trim(),
      });
      status = await updateSetupState({
        dismissed: false,
        steps: {
          workspace: {
            skipped: false,
            choice: "custom",
          },
        },
      });
      printSuccess("Workspace preference saved.");
    }

    const { oauthChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "oauthChoice",
        message: "Shared Google OAuth app:",
        default: googleOAuth?.has_credentials ? "configure" : "later",
        choices: [
          { name: "Configure Google shared OAuth", value: "configure" },
          { name: "Skip for now", value: "later" },
        ],
      },
    ]);

    if (oauthChoice === "later") {
      status = await updateSetupState({
        dismissed: false,
        steps: {
          oauth_apps: {
            skipped: true,
            choice: "later",
          },
        },
      });
    } else {
      if (googleOAuth?.redirect_uri) {
        console.log(chalk.gray(`\n  Google redirect URI: ${googleOAuth.redirect_uri}\n`));
      }

      const { clientId, clientSecret } = await inquirer.prompt([
        {
          type: "input",
          name: "clientId",
          message: "Google OAuth client ID:",
        },
        {
          type: "password",
          name: "clientSecret",
          message: "Google OAuth client secret:",
          mask: "*",
        },
      ]);

      if ((!clientId?.trim() || !clientSecret?.trim()) && !googleOAuth?.has_credentials) {
        throw new Error("Both Google OAuth values are required unless shared credentials are already saved.");
      }

      if (clientId?.trim() || clientSecret?.trim()) {
        await apiPut("/oauth-providers/google", {
          client_id: clientId.trim(),
          client_secret: clientSecret.trim(),
        });
      }

      status = await updateSetupState({
        dismissed: false,
        steps: {
          oauth_apps: {
            skipped: false,
            choice: "google",
          },
        },
      });
      printSuccess("Shared Google OAuth settings saved.");
    }

    console.log("");
    printSuccess("Setup complete. Current status:");
    await printSetupStatus({});
  } catch (err) {
    handleError(err, {});
  }
}

export function registerSetupCommand(program: Command) {
  const cmd = program
    .command("setup")
    .description("Run the optional GTMShip onboarding checklist");

  cmd
    .command("status")
    .description("Show setup checklist status")
    .option("--json", "Output as JSON")
    .action((opts) => void printSetupStatus(opts));

  cmd.action(() => void setupCommand());
}
