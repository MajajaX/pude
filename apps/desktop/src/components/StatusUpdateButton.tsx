import { updateStatus } from "../lib/app-update";
import { downloadAvailableUpdate, restartAndUpdate } from "../lib/app-update-actions";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";

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
      ? t("Restart to install pude {version}", { version: updateStatus().version })
      : t("Download pude {version}", { version: updateStatus().version }))}
    onClick={() => void runUpdate()}
  >
    <Icon name={updateStatus().phase === "ready" ? "refresh" : "arrow-down"} size={12} />
    {updateStatus().phase === "ready" ? t("Restart and update")
      : updateStatus().phase === "downloading" ? t("Downloading…") : t("Update {version}", { version: updateStatus().version })}
  </button>;
}
