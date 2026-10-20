import { createSignal } from "solid-js";
import { checkForUpdate } from "./bridge";
import { errorMessage } from "./core";

export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready";

export type UpdateStatus = {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  error?: string;
};

const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>({ phase: "idle" });

export { updateStatus, setUpdateStatus };

export async function checkForUpdates(): Promise<void> {
  const { phase } = updateStatus();
  if (phase === "checking" || phase === "downloading") return;
  setUpdateStatus({ phase: "checking" });
  try {
    const update = await checkForUpdate();
    setUpdateStatus(update
      ? { phase: "available", version: update.version, notes: update.notes ?? undefined }
      : { phase: "up-to-date" });
  } catch (error) {
    setUpdateStatus({ phase: "idle", error: errorMessage(error, "Could not check for updates.") });
  }
}
