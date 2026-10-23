import { createEffect, onCleanup, onMount } from "solid-js";
import { confirmDialogKeyAction } from "../lib/confirm-dialog-keyboard";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { t } from "../lib/i18n";

export type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  let dialog: HTMLElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;
    if (event.key === "Tab") {
      if (props.busy) {
        event.preventDefault();
        modalFocus.focusDialog();
      } else {
        modalFocus.handleKeyDown(event);
      }
      return;
    }

    const action = confirmDialogKeyAction(event, props.busy === true);
    if (action === "none") return;

    event.preventDefault();
    if (action === "cancel") {
      event.stopPropagation();
      props.onCancel();
    } else if (action === "prevent") {
      event.stopPropagation();
    }
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
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div class="modal-heading">
          <div>
            <span class="modal-kicker">{t("CONFIRM ACTION")}</span>
            <h2 id="confirm-dialog-title">{props.title}</h2>
          </div>
        </div>
        <div class="conflict-body">
          <p id="confirm-dialog-message">{props.message}</p>
        </div>
        <div class="modal-footer conflict-actions">
          <button
            ref={(element) => { cancelButton = element; }}
            type="button"
            class="secondary-button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            type="button"
            class={props.destructive ? "danger-button" : "primary-button"}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
