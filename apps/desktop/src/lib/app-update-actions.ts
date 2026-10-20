import { downloadUpdate, restartToUpdate } from "./bridge";
import { errorMessage } from "./core";
import { setUpdateStatus, updateStatus } from "./app-update";

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
