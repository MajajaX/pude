import { createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { clampSetting, defaultSettings, parseWatcherExcludes, settingRange, type NumericSetting } from "../lib/settings";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import type { AppSettings } from "../types";
import "../styles/settings-dialog.css";
import { t } from "../lib/i18n";

export function SettingsDialog(props: {
  settings: AppSettings;
  onChange: (changes: Partial<AppSettings>) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | undefined;
}) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  const [confirmingReset, setConfirmingReset] = createSignal(false);

  // Restoring keeps the interface language so the dialog stays readable.
  const restoreDefaults = () => {
    if (!confirmingReset()) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    props.onChange({ ...defaultSettings, language: props.settings.language });
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
            <span class="settings-dialog-kicker">{t("PREFERENCES")}</span>
            <h2 id="settings-dialog-title">{t("Settings")}</h2>
          </div>
          <button
            ref={(element) => { closeButton = element; }}
            type="button"
            class="icon-button"
            onClick={props.onClose}
            aria-label={t("Close settings")}
          >
            <Icon name="close" size={13} />
          </button>
        </header>

        <div class="settings-dialog-content">
          <h3 class="settings-dialog-section">{t("Interface")}</h3>
          <label class="settings-dialog-row" for="settings-language">
            <span>{t("Language")}</span>
            <select
              id="settings-language"
              value={props.settings.language}
              onChange={(event) => props.onChange({ language: event.currentTarget.value as AppSettings["language"] })}
            >
              <option value="auto">{t("System default")}</option>
              <option value="en">{t("English")}</option>
              <option value="zh-Hant">繁體中文</option>
            </select>
          </label>
          <label class="settings-dialog-row" for="settings-theme">
            <span>{t("Theme")}</span>
            <select
              id="settings-theme"
              value={props.settings.theme}
              onChange={(event) => props.onChange({ theme: event.currentTarget.value as AppSettings["theme"] })}
            >
              <option value="dark">{t("Dark")}</option>
              <option value="light">{t("Light")}</option>
            </select>
          </label>

          <h3 class="settings-dialog-section">{t("Editor")}</h3>
          <NumberRow name="fontSize" label={t("Font size")} settings={props.settings} onChange={props.onChange} />
          <NumberRow name="tabSize" label={t("Tab size")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="insertSpaces" label={t("Indent with spaces")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="wordWrap" label={t("Word wrap")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="lineNumbers" label={t("Line numbers")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="showWhitespace" label={t("Show whitespace")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="autoCloseBrackets" label={t("Close brackets and quotes automatically")} settings={props.settings} onChange={props.onChange} />

          <h3 class="settings-dialog-section">{t("Saving")}</h3>
          <Toggle name="trimTrailingWhitespace" label={t("Trim trailing whitespace on save")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="insertFinalNewline" label={t("End files with a newline on save")} settings={props.settings} onChange={props.onChange} />

          <h3 class="settings-dialog-section">{t("Explorer")}</h3>
          <Toggle name="hideDotFiles" label={t("Hide dot files")} settings={props.settings} onChange={props.onChange} />
          <Toggle name="groupGitIgnoredFiles" label={t("Group Git ignored files")} settings={props.settings} onChange={props.onChange} />

          <h3 class="settings-dialog-section">{t("Updates")}</h3>
          <Toggle name="checkForUpdates" label={t("Check for updates on startup")} settings={props.settings} onChange={props.onChange} />
          <div class="settings-dialog-block">
            <label for="settings-watcher-excludes">{t("Watcher excluded paths")}</label>
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
              {t("Skip change notifications for these paths to reduce background updates. One path per line; relative paths use the workspace, and folders include descendants. Open editor files remain watched.")}
            </small>
          </div>
          <footer class="settings-dialog-footer">
            <button type="button" class="settings-dialog-reset" onClick={restoreDefaults}>
              {confirmingReset() ? t("Click again to restore defaults") : t("Restore defaults")}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}

type SettingProps<Name> = {
  name: Name;
  label: string;
  settings: AppSettings;
  onChange: (changes: Partial<AppSettings>) => void;
};

type BooleanSettingName = "insertSpaces" | "wordWrap" | "lineNumbers" | "showWhitespace" | "autoCloseBrackets" | "trimTrailingWhitespace" | "insertFinalNewline" | "hideDotFiles" | "groupGitIgnoredFiles" | "checkForUpdates";

function Toggle(props: SettingProps<BooleanSettingName>) {
  const id = `settings-${props.name}`;
  return (
    <label class="settings-dialog-toggle" for={id}>
      <span>{props.label}</span>
      <input id={id} type="checkbox" checked={props.settings[props.name]} onChange={(event) => props.onChange({ [props.name]: event.currentTarget.checked })} />
    </label>
  );
}

// The value is applied when the field is committed, so typing "16" never passes through 11.
function NumberRow(props: SettingProps<Extract<NumericSetting, "fontSize" | "tabSize">>) {
  const id = `settings-${props.name}`;
  const range = settingRange(props.name);
  return (
    <label class="settings-dialog-row" for={id}>
      <span>{props.label} <small class="settings-dialog-range">{range.min}–{range.max}</small></span>
      <input
        id={id}
        type="number"
        min={range.min}
        max={range.max}
        value={props.settings[props.name]}
        onChange={(event) => {
          const value = clampSetting(props.name, event.currentTarget.value, props.settings[props.name]);
          event.currentTarget.value = String(value);
          props.onChange({ [props.name]: value });
        }}
      />
    </label>
  );
}
