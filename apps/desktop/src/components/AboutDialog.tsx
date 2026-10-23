import { Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { checkForUpdates, updateStatus } from "../lib/app-update";
import { downloadAvailableUpdate, restartAndUpdate } from "../lib/app-update-actions";
import { t } from "../lib/i18n";

export function AboutDialog(props: {
  version: string;
  returnFocus?: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    modalFocus.handleKeyDown(event);
  };

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, {
      initialFocus: () => closeButton,
      returnFocus: props.returnFocus,
    });
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section
        ref={(element) => { dialog = element; }}
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        aria-describedby="about-update-status"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div class="modal-heading">
          <div>
            <span class="modal-kicker">{t("PUDE")}</span>
            <h2 id="about-title">{t("About pude")}</h2>
          </div>
          <button ref={(element) => { closeButton = element; }} type="button" class="icon-button" onClick={props.onClose} aria-label={t("Close About")}>
            ×
          </button>
        </div>
        <div class="input-dialog-body">
          <p><strong>{t("Version {version}", { version: props.version })}</strong></p>
          <p id="about-update-status" role="status">
            <Switch fallback={t("Check GitHub for a newer version of pude.")}>
              <Match when={updateStatus().phase === "checking"}>{t("Checking for updates…")}</Match>
              <Match when={updateStatus().phase === "up-to-date"}>{t("pude is up to date.")}</Match>
              <Match when={updateStatus().phase === "available"}>{t("pude {version} is available.", { version: updateStatus().version })}</Match>
              <Match when={updateStatus().phase === "downloading"}>{t("Downloading pude {version}…", { version: updateStatus().version })}</Match>
              <Match when={updateStatus().phase === "ready"}>{t("pude {version} is ready. pude asks about unsaved changes before it restarts.", { version: updateStatus().version })}</Match>
            </Switch>
          </p>
          <Show when={updateStatus().notes}>
            <pre class="about-release-notes">{updateStatus().notes}</pre>
          </Show>
          <Switch>
            <Match when={updateStatus().phase === "available"}>
              <button class="secondary-button" type="button" onClick={() => void downloadAvailableUpdate()}>{t("Download update")}</button>
            </Match>
            <Match when={updateStatus().phase === "ready"}>
              <button class="secondary-button" type="button" onClick={() => void restartAndUpdate()}>{t("Restart and update")}</button>
            </Match>
            <Match when={true}>
              <button
                class="secondary-button"
                type="button"
                disabled={updateStatus().phase === "checking" || updateStatus().phase === "downloading"}
                onClick={() => void checkForUpdates()}
              >
                {t("Check for updates")}
              </button>
            </Match>
          </Switch>
          <Show when={updateStatus().error}>
            <p class="about-release-error" role="alert">{updateStatus().error}</p>
          </Show>
        </div>
        <div class="modal-footer">
          <button type="button" class="secondary-button" onClick={props.onClose}>{t("Done")}</button>
        </div>
      </section>
    </div>
  );
}
