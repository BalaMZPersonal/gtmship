import { printRuntimeStatus, startLocalRuntime } from "../lib/local-runtime.js";

export async function startCommand(): Promise<void> {
  const status = await startLocalRuntime();
  printRuntimeStatus(status);
}
