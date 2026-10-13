import { createEffect, onCleanup, onMount } from "solid-js";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";

export function CloseWindowDialog(props: {
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onPreserve?: () => void;
  projectName?: string;
  onCancel: () => void;
}) {
  let dialog: HTMLElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (!props.busy) props.onCancel();
      return;
    }

    if (event.key === "Tab" && props.busy) {
      event.preventDefault();
      modalFocus.focusDialog();
      return;
    }

    modalFocus.handleKeyDown(event);
  };

  createEffect(() => {
    if (props.busy && modalFocus?.isTopmost()) modalFocus.focusDialog();
  });

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, { initialFocus: () => props.busy ? null : cancelButton });
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="modal-backdrop">
      <section
        ref={(element) => { dialog = element; }}
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-window-title"
        aria-describedby="close-window-description"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div class="modal-heading">
          <div>
            <span class="modal-kicker">UNSAVED CHANGES</span>
            <h2 id="close-window-title">{props.projectName ? `Close ${props.projectName}?` : "Close window?"}</h2>
          </div>
        </div>
        <div class="conflict-body">
          <p id="close-window-description">{props.projectName ? "This project's files have unsaved changes. Closing also ends its terminals." : "One or more projects have unsaved changes."}</p>
        </div>
        <div class="modal-footer conflict-actions">
          <button ref={(element) => { cancelButton = element; }} class="secondary-button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <button class="secondary-button" disabled={props.busy} onClick={props.onDiscard}>Discard</button>
          <button class={props.onPreserve ? "secondary-button" : "primary-button"} disabled={props.busy} onClick={props.onSave}>{props.busy ? "Working…" : props.projectName ? "Save project" : "Save all"}</button>
          {props.onPreserve && <button class="primary-button" disabled={props.busy} onClick={props.onPreserve}>Keep changes &amp; close</button>}
        </div>
      </section>
    </div>
  );
}
