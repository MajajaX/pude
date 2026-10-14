import { createSignal } from "solid-js";
import { checkForUpdate, downloadUpdate, restartToUpdate } from "./bridge";
import { errorMessage } from "./core";

export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready";

export type UpdateStatus = {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  error?: string;
};

const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>({ phase: "idle" });

export { updateStatus };

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

export async function downloadAvailableUpdate(): Promise<void> {
  const available = updateStatus();
  if (available.phase !== "available") return;
  setUpdateStatus({ ...available, phase: "downloading", error: undefined });
  try {
    await downloadUpdate();
    setUpdateStatus({ ...available, phase: "ready" });
  } catch (error) {
    setUpdateStatus({ ...available, error: errorMessage(error, "Could not download the update.") });
  }
}

export async function restartAndUpdate(): Promise<void> {
  const ready = updateStatus();
  if (ready.phase !== "ready") return;
  try {
    await restartToUpdate();
  } catch (error) {
    setUpdateStatus({ ...ready, error: errorMessage(error, "Could not restart to update.") });
  }
}
