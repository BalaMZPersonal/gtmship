import { startLocalRuntime, printRuntimeStatus } from "../lib/local-runtime.js";

export async function openCommand(): Promise<void> {
  const status = await startLocalRuntime({
    openBrowser: true,
    installLaunchAgent: true,
  });
  printRuntimeStatus(status);
}
