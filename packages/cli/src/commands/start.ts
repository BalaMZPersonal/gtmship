import { printRuntimeStatus, startLocalRuntime } from "../lib/local-runtime.js";
import { maybePrintRuntimeUpdateNotice } from "../lib/updates.js";

export async function startCommand(): Promise<void> {
  const status = await startLocalRuntime();
  printRuntimeStatus(status);
  await maybePrintRuntimeUpdateNotice();
}
