import { getLocalRuntimeStatus, printRuntimeStatus } from "../lib/local-runtime.js";

export async function statusCommand(): Promise<void> {
  const status = await getLocalRuntimeStatus();
  printRuntimeStatus(status);
}
