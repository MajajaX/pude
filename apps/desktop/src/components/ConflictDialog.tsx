import { onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import type { EditorTab } from "../types";

export function ConflictDialog(props: { tab: EditorTab; onCompare: () => void; onReload: () => void; onSaveAs: () => void; onKeep: () => void }) {
  let dialog: HTMLElement | undefined;
  let compareButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      props.onKeep();
      return;
    }

    modalFocus.handleKeyDown(event);
  };

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, { initialFocus: () => compareButton });
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="modal-backdrop">
      <section
        ref={(element) => { dialog = element; }}
        class="modal conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        aria-describedby="conflict-description conflict-warning"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div class="modal-heading">
          <div>
            <span class="modal-kicker">EXTERNAL CHANGE</span>
            <h2 id="conflict-title">File changed on disk</h2>
          </div>
          <button class="icon-button" onClick={props.onKeep} aria-label="Keep editor version"><Icon name="close" /></button>
        </div>
        <div class="conflict-body">
          <p id="conflict-description"><strong>{props.tab.name}</strong> has changed outside pude while this tab still has unsaved edits.</p>
          <p id="conflict-warning" class="conflict-warning">Your editor version will never be overwritten automatically.</p>
        </div>
        <div class="modal-footer conflict-actions">
          <button ref={(element) => { compareButton = element; }} class="secondary-button" onClick={props.onCompare}>Compare</button>
          <button class="secondary-button" onClick={props.onReload}>Reload from disk</button>
          <button class="secondary-button" onClick={props.onSaveAs}>Save As…</button>
          <button class="primary-button" onClick={props.onKeep}>Keep editor version</button>
        </div>
      </section>
    </div>
  );
}
