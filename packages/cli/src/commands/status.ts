import { getLocalRuntimeStatus, printRuntimeStatus } from "../lib/local-runtime.js";
import { maybePrintRuntimeUpdateNotice } from "../lib/updates.js";

export async function statusCommand(): Promise<void> {
  const status = await getLocalRuntimeStatus();
  printRuntimeStatus(status);
  await maybePrintRuntimeUpdateNotice();
}
