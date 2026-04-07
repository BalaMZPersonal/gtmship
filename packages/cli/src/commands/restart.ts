import { printRuntimeStatus, restartLocalRuntime } from "../lib/local-runtime.js";
import { maybePrintRuntimeUpdateNotice } from "../lib/updates.js";

export async function restartCommand(): Promise<void> {
  const status = await restartLocalRuntime();
  printRuntimeStatus(status);
  await maybePrintRuntimeUpdateNotice();
}
