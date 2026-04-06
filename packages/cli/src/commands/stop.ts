import { printRuntimeStatus, stopLocalRuntime } from "../lib/local-runtime.js";

export async function stopCommand(): Promise<void> {
  const status = await stopLocalRuntime();
  printRuntimeStatus(status);
}
