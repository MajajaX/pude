import { createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { shouldSubmitOnEnter } from "../lib/keyboard-input";
import { t } from "../lib/i18n";

export type InputDialogProps = {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

export function InputDialog(props: InputDialogProps) {
  const [value, setValue] = createSignal(props.initialValue ?? "");
  let dialog: HTMLElement | undefined;
  let input: HTMLInputElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  let isComposing = false;

  const submit = () => {
    const nextValue = value().trim();
    if (nextValue) props.onSubmit(nextValue);
  };

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }

    modalFocus.handleKeyDown(event);
  };

  const handleInputKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;
    if (!shouldSubmitOnEnter(event, isComposing)) return;

    event.preventDefault();
    submit();
  };

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, { initialFocus: () => input });
    if (modalFocus?.isTopmost()) input?.select();
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section
        ref={(element) => { dialog = element; }}
        class="modal input-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="input-dialog-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div class="modal-heading">
          <div>
            <span class="modal-kicker">{t("PUDE INPUT")}</span>
            <h2 id="input-dialog-title">{props.title}</h2>
          </div>
          <button type="button" class="icon-button" onClick={props.onClose} aria-label={t("Close input dialog")}><Icon name="close" size={13} /></button>
        </div>
        <div class="input-dialog-body">
          <label for="input-dialog-field">{props.label}</label>
          <input
            id="input-dialog-field"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            ref={(element) => { input = element; }}
            value={value()}
            placeholder={props.placeholder}
            aria-required="true"
            onInput={(event) => setValue(event.currentTarget.value)}
            onCompositionStart={() => { isComposing = true; }}
            onCompositionEnd={() => { isComposing = false; }}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        <div class="modal-footer input-dialog-actions">
          <button type="button" class="secondary-button" onClick={props.onClose}>{t("Cancel")}</button>
          <button type="button" class="primary-button" disabled={!value().trim()} onClick={submit}>{props.submitLabel ?? t("Confirm")}</button>
        </div>
      </section>
    </div>
  );
}
