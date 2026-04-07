import type { Command } from "commander";
import {
  confirmAction,
  formatOutput,
  handleError,
  printDetail,
  printSuccess,
  printWarning,
  type OutputOptions,
} from "../lib/output.js";
import {
  getCliUpdateStatus,
  restartInstalledRuntime,
  runHomebrewUpdate,
  type CliUpdateStatus,
} from "../lib/updates.js";

type UpdateOptions = OutputOptions & {
  check?: boolean;
  yes?: boolean;
};

function renderUpdateStatus(status: CliUpdateStatus): void {
  console.log("");
  printDetail("Current Version", status.currentVersion);
  printDetail("Running Version", status.runtimeRunning ? status.runningVersion : "not running");
  printDetail("Installed Version", status.installedVersion || "unknown");
  printDetail("Latest Version", status.latestVersion || "unavailable");
  printDetail("Install Method", status.installMethod);
  printDetail("Update Available", status.updateAvailable ? "yes" : "no");
  printDetail("Restart Required", status.restartRequired ? "yes" : "no");
  if (status.recommendedCommand) {
    printDetail("Recommended", status.recommendedCommand);
  }
  if (status.notesUrl) {
    printDetail("Release Notes", status.notesUrl);
  }
  if (status.message) {
    printDetail("Message", status.message);
  }
  if (status.stale) {
    printWarning("Release metadata could not be refreshed. This result may be stale.");
  }
  console.log("");
}

async function printUpdateCheck(opts: UpdateOptions) {
  try {
    const status = await getCliUpdateStatus({ preferRemote: false });
    formatOutput(status, opts, () => renderUpdateStatus(status));
  } catch (error) {
    handleError(error, opts);
  }
}

async function updateCommand(opts: UpdateOptions) {
  if (opts.check) {
    await printUpdateCheck(opts);
    return;
  }

  try {
    const status = await getCliUpdateStatus({ preferRemote: false });

    if (status.restartRequired) {
      const confirmed = await confirmAction(
        "GTMShip is already upgraded on disk. Restart the local runtime now?",
        { force: opts.yes, json: opts.json }
      );
      if (!confirmed) {
        return;
      }

      const restart = await restartInstalledRuntime({
        stream: !opts.json,
      });
      if (restart.code !== 0) {
        throw new Error(restart.stderr || "Failed to restart GTMShip.");
      }

      const nextStatus = await getCliUpdateStatus({ preferRemote: false });
      formatOutput(
        {
          ...nextStatus,
          restarted: true,
        },
        opts,
        () => {
          printSuccess("Restarted GTMShip with the installed runtime.");
          renderUpdateStatus(nextStatus);
        }
      );
      return;
    }

    if (!status.updateAvailable && !status.stale) {
      formatOutput(status, opts, () => {
        printSuccess("GTMShip is already up to date.");
        renderUpdateStatus(status);
      });
      return;
    }

    if (status.installMethod !== "homebrew") {
      formatOutput(status, opts, () => {
        printWarning(
          "This GTMShip install is not managed by Homebrew, so automatic upgrade is unavailable."
        );
        renderUpdateStatus(status);
      });
      return;
    }

    const confirmed = await confirmAction(
      status.stale
        ? "Could not verify the latest published version. Run the Homebrew upgrade anyway?"
        : `Upgrade GTMShip from ${status.installedVersion || status.currentVersion} to ${status.latestVersion}?`,
      { force: opts.yes, json: opts.json }
    );
    if (!confirmed) {
      return;
    }

    const hadRunningRuntime = status.runtimeRunning;
    const upgrade = await runHomebrewUpdate({
      stream: !opts.json,
    });
    if (upgrade.code !== 0) {
      throw new Error(upgrade.stderr || "Homebrew upgrade failed.");
    }

    let restarted = false;
    if (hadRunningRuntime) {
      const restart = await restartInstalledRuntime({
        brewPrefix: upgrade.prefix,
        stream: !opts.json,
      });
      if (restart.code === 0) {
        restarted = true;
      } else if (!opts.json) {
        printWarning(
          "The package upgraded successfully, but GTMShip did not restart cleanly. Run `gtmship restart` to load the new runtime."
        );
      }
    }

    const nextStatus = await getCliUpdateStatus({ preferRemote: false });
    formatOutput(
      {
        ...nextStatus,
        upgraded: true,
        restarted,
      },
      opts,
      () => {
        printSuccess("Updated GTMShip through Homebrew.");
        if (hadRunningRuntime && restarted) {
          printSuccess("Restarted the local GTMShip runtime.");
        } else if (hadRunningRuntime) {
          printWarning("Run `gtmship restart` to load the updated runtime.");
        }
        renderUpdateStatus(nextStatus);
      }
    );
  } catch (error) {
    handleError(error, opts);
  }
}

export function registerUpdateCommand(program: Command) {
  program
    .command("update")
    .description("Check for GTMShip updates and upgrade Homebrew installs")
    .option("--check", "Only check for updates")
    .option("--yes", "Skip confirmation prompts")
    .option("--json", "Output as JSON")
    .action((opts) => void updateCommand(opts));
}
