import { createSignal, onCleanup, onMount } from "solid-js";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { errorMessage } from "../lib/core";

export function AboutDialog(props: {
  version: string;
  stage: string;
  releaseUrl?: string;
  releaseAction?: "check" | "download";
  onOpenRelease: (url: string) => Promise<void>;
  returnFocus?: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  const [openingRelease, setOpeningRelease] = createSignal(false);
  const [releaseError, setReleaseError] = createSignal("");

  const openRelease = async () => {
    if (!props.releaseUrl || openingRelease()) return;
    setOpeningRelease(true);
    setReleaseError("");
    try {
      await props.onOpenRelease(props.releaseUrl);
    } catch (error) {
      setReleaseError(errorMessage(
        error,
        props.releaseAction === "check" ? "Could not check for releases." : "Could not open the release page.",
      ));
    } finally {
      setOpeningRelease(false);
    }
  };

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
            <span class="modal-kicker">PUDE</span>
            <h2 id="about-title">About pude</h2>
          </div>
          <button ref={(element) => { closeButton = element; }} type="button" class="icon-button" onClick={props.onClose} aria-label="Close About">
            ×
          </button>
        </div>
        <div class="input-dialog-body">
          <p><strong>Version {props.version}</strong> · {props.stage}</p>
          <p id="about-update-status">
            {props.releaseAction === "check"
              ? "Updates are manual. Select Check for releases to look for a public release now; the app does not check automatically."
              : props.releaseUrl
                ? "Updates are manual. Open the configured release to download the current installer."
              : "Manual downloads are not available yet. No published release is configured."}
          </p>
          {props.releaseUrl ? (
            <button class="secondary-button" type="button" onClick={() => void openRelease()} aria-busy={openingRelease()}>
              {openingRelease()
                ? props.releaseAction === "check" ? "Checking for releases…" : "Opening release…"
                : props.releaseAction === "check" ? "Check for releases" : "View release and download"}
            </button>
          ) : (
            <button class="secondary-button" type="button" disabled aria-describedby="about-update-status">
              Releases unavailable
            </button>
          )}
          {releaseError() && <p class="about-release-error" role="alert">{releaseError()}</p>}
        </div>
        <div class="modal-footer">
          <button type="button" class="secondary-button" onClick={props.onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
