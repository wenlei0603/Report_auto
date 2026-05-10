import type { FinalTaskStatus } from "../domain/types.js";

export function shouldWorkerContinueAfterStatus(status: FinalTaskStatus): boolean {
  return status !== "page_limit" && status !== "max_downloads";
}
