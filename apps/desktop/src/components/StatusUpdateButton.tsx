import { updateStatus } from "../lib/app-update";
import { downloadAvailableUpdate, restartAndUpdate } from "../lib/app-update-actions";
import { Icon } from "./Icons";

export function StatusUpdateButton(props: { onError: () => void }) {
  const runUpdate = async () => {
    if (updateStatus().phase === "ready") await restartAndUpdate();
    else await downloadAvailableUpdate();
    if (updateStatus().error) props.onError();
  };

  return <button
    class="status-update"
    type="button"
    disabled={updateStatus().phase === "downloading"}
    title={updateStatus().error ?? (updateStatus().phase === "ready"
      ? `Restart to install pude ${updateStatus().version}`
      : `Download pude ${updateStatus().version}`)}
    onClick={() => void runUpdate()}
  >
    <Icon name={updateStatus().phase === "ready" ? "refresh" : "arrow-down"} size={12} />
    {updateStatus().phase === "ready" ? "Restart and update"
      : updateStatus().phase === "downloading" ? "Downloading…" : `Update ${updateStatus().version}`}
  </button>;
}
