import { onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { clampSetting, parseWatcherExcludes } from "../lib/settings";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import type { AppSettings } from "../types";
import "../styles/settings-dialog.css";

export function SettingsDialog(props: {
  settings: AppSettings;
  onChange: (changes: Partial<AppSettings>) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | undefined;
}) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const handleDialogKeyDown = (event: KeyboardEvent) => {
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
    <div
      class="settings-dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <section
        ref={(element) => { dialog = element; }}
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header class="settings-dialog-heading">
          <div>
            <span class="settings-dialog-kicker">PREFERENCES</span>
            <h2 id="settings-dialog-title">Settings</h2>
          </div>
          <button
            ref={(element) => { closeButton = element; }}
            type="button"
            class="icon-button"
            onClick={props.onClose}
            aria-label="Close settings"
          >
            <Icon name="close" size={13} />
          </button>
        </header>

        <div class="settings-dialog-content">
          <label class="settings-dialog-row" for="settings-font-size">
            <span>Font size</span>
            <input
              id="settings-font-size"
              type="number"
              min="11"
              max="24"
              value={props.settings.fontSize}
              onInput={(event) => props.onChange({ fontSize: clampSetting("fontSize", event.currentTarget.value, props.settings.fontSize) })}
            />
          </label>
          <label class="settings-dialog-row" for="settings-tab-size">
            <span>Tab size</span>
            <input
              id="settings-tab-size"
              type="number"
              min="1"
              max="8"
              value={props.settings.tabSize}
              onInput={(event) => props.onChange({ tabSize: clampSetting("tabSize", event.currentTarget.value, props.settings.tabSize) })}
            />
          </label>
          <label class="settings-dialog-toggle" for="settings-word-wrap">
            <span>Word wrap</span>
            <input
              id="settings-word-wrap"
              type="checkbox"
              checked={props.settings.wordWrap}
              onChange={(event) => props.onChange({ wordWrap: event.currentTarget.checked })}
            />
          </label>
          <label class="settings-dialog-toggle" for="settings-hide-dot-files">
            <span>Hide dot files in Explorer</span>
            <input
              id="settings-hide-dot-files"
              type="checkbox"
              checked={props.settings.hideDotFiles}
              onChange={(event) => props.onChange({ hideDotFiles: event.currentTarget.checked })}
            />
          </label>
          <label class="settings-dialog-toggle" for="settings-check-for-updates">
            <span>Check for updates on startup</span>
            <input
              id="settings-check-for-updates"
              type="checkbox"
              checked={props.settings.checkForUpdates}
              onChange={(event) => props.onChange({ checkForUpdates: event.currentTarget.checked })}
            />
          </label>
          <div class="settings-dialog-block">
            <label for="settings-watcher-excludes">Watcher excluded paths</label>
            <textarea
              id="settings-watcher-excludes"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              rows="4"
              value={props.settings.watcherExcludes.join("\n")}
              placeholder={"node_modules\ndist"}
              aria-describedby="settings-watcher-excludes-help"
              onChange={(event) => props.onChange({ watcherExcludes: parseWatcherExcludes(event.currentTarget.value, props.settings.watcherExcludes) })}
            />
            <small id="settings-watcher-excludes-help">
              Skip change notifications for these paths to reduce background updates. One path per line; relative paths use the workspace, and folders include descendants. Open editor files remain watched.
            </small>
          </div>
        </div>
      </section>
    </div>
  );
}
