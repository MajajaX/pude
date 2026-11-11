import { For, Index, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";
import {
  dotenvAppendEdit,
  dotenvInsertEdit,
  dotenvDeleteEdit,
  dotenvKeyEdit,
  dotenvLine,
  dotenvValueEdit,
  parseDotenv,
  sanitizeDotenvKey,
} from "../lib/dotenv";
import type { DotenvEntry, DotenvNote, DotenvVariable } from "../lib/dotenv";
import { generateSecret, readSecretOptions, saveSecretOptions } from "../lib/random-secret";
import type { SecretFormat, SecretOptions } from "../lib/random-secret";
import type { PluginEditorEdit } from "../lib/plugin-editor-edits";
import "../styles/env-table.css";

export const ENV_TABLE_MAX_CHARS = 512 * 1024;

type CopyPart = "name" | "value" | "line";

const NEW_VARIABLE_GENERATOR = -1;
const DRAFT_GENERATOR = -2;

type DraftVariable = { key: string; value: string; index: number; side: "above" | "below" };

type EnvTableProps = {
  revision: number;
  readText: () => string;
  applyEdits: (edits: readonly PluginEditorEdit[], isolated?: boolean) => boolean;
  onHistory: (direction: "undo" | "redo") => void;
  onCopy: (value: string, message: string) => Promise<boolean>;
};

export function EnvTable(props: EnvTableProps) {
  const text = createMemo(() => {
    void props.revision;
    return props.readText();
  });
  const tooLarge = () => text().length > ENV_TABLE_MAX_CHARS;
  const entries = createMemo(() => (tooLarge() ? [] : parseDotenv(text())));
  const variableCount = () => entries().filter((entry) => entry.kind === "variable").length;

  const [copied, setCopied] = createSignal<string>();
  // Values are masked until shown, so a shared screen does not reveal secrets; a focused field shows its value for editing.
  const [valuesShown, setValuesShown] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  // A new variable stays on screen until focus leaves its row with a name, which writes it to the file, or with nothing typed, which discards it.
  const [draft, setDraft] = createSignal<DraftVariable>();
  const [menu, setMenu] = createSignal<number>();
  const [generator, setGenerator] = createSignal<number>();
  const [popupPosition, setPopupPosition] = createSignal({ x: 0, y: 0 });
  let popupTrigger: HTMLElement | null = null;
  // Focus moves before the popup leaves the DOM, so a draft row never sees its focus drop.
  const closePopup = (restore = false) => {
    if (restore) popupTrigger?.focus();
    setMenu(undefined);
    setGenerator(undefined);
  };
  const showMenu = (index: number, x: number, y: number, trigger: HTMLElement) => {
    popupTrigger = trigger;
    setGenerator(undefined);
    setPopupPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - 200)),
      y: Math.max(8, Math.min(y, window.innerHeight - 130)),
    });
    setMenu(index);
    queueMicrotask(() => document.querySelector<HTMLButtonElement>(".env-menu button")?.focus());
  };
  onMount(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".env-menu-wrap, .env-generate"))
        closePopup(generator() === DRAFT_GENERATOR);
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });
  const [options, setOptions] = createSignal<SecretOptions>(readSecretOptions());
  const [preview, setPreview] = createSignal("");
  const updateOptions = (next: SecretOptions) => {
    setOptions(next);
    saveSecretOptions(next);
    setPreview(generateSecret(next));
  };
  const openGenerator = (index: number, trigger?: HTMLElement) => {
    if (trigger) popupTrigger = trigger;
    const rect = (trigger ?? popupTrigger)?.getBoundingClientRect();
    if (rect)
      setPopupPosition({
        x: Math.max(8, Math.min(rect.right - 340, window.innerWidth - 350)),
        y: Math.max(8, Math.min(rect.bottom, window.innerHeight - 350)),
      });
    setMenu(undefined);
    setGenerator(index);
    setPreview(generateSecret(options()));
    queueMicrotask(() => document.querySelector<HTMLSelectElement>(".env-generator select")?.focus());
  };
  let draftRow: HTMLDivElement | undefined;
  let draftKeyInput: HTMLInputElement | undefined;

  const copy = async (variable: DotenvVariable, index: number, part: CopyPart) => {
    const value = part === "name" ? variable.key : part === "value" ? variable.value : dotenvLine(text(), variable);
    const message =
      part === "name"
        ? t("Copied the name {key}.", { key: variable.key })
        : part === "value"
          ? t("Copied the value of {key}.", { key: variable.key })
          : t("Copied the line {key}=….", { key: variable.key });
    if (!(await props.onCopy(value, message))) return;
    clearTimeout(copiedTimer);
    setCopied(`${index}:${part}`);
    copiedTimer = setTimeout(() => setCopied(undefined), 1200);
  };

  const sanitizeKeyInput = (input: HTMLInputElement) => {
    const key = sanitizeDotenvKey(input.value);
    if (key !== input.value) input.value = key;
    return key;
  };

  // Cells write to the document when they lose focus or Enter is pressed, not on every keystroke.
  const commitKey = (variable: DotenvVariable, input: HTMLInputElement) => {
    const key = sanitizeKeyInput(input);
    if (key !== variable.key && !props.applyEdits([dotenvKeyEdit(variable, key)])) input.value = variable.key;
  };

  const commitValue = (variable: DotenvVariable, input: HTMLInputElement | HTMLTextAreaElement) => {
    if (input.value !== variable.value && !props.applyEdits([dotenvValueEdit(variable, input.value)]))
      input.value = variable.value;
  };

  const addVariable = (index?: number, side: "above" | "below" = "below", value = "") => {
    const list = entries();
    const last = list.map((entry) => entry.kind).lastIndexOf("variable");
    if (!draft()) setDraft({ key: "", value, index: index ?? last, side });
    setMenu(undefined);
    queueMicrotask(() => {
      draftKeyInput?.scrollIntoView({ block: "nearest" });
      draftKeyInput?.focus();
    });
  };

  const draftNeedsName = () => !draft()?.key && !!draft()?.value.trim();

  // A draft with a value but no name stays open instead of writing a nameless `=value` line.
  const finishDraft = (event: FocusEvent) => {
    if (generator() === DRAFT_GENERATOR || draftRow?.contains(event.relatedTarget as Node | null)) return;
    const current = draft();
    if (!current || (!current.key && !current.value.trim())) {
      setDraft(undefined);
      return;
    }
    const target = current.index >= 0 ? entries()[current.index] : undefined;
    const edit = target
      ? dotenvInsertEdit(text(), target, current.side, current.key, current.value)
      : dotenvAppendEdit(text(), current.key, current.value);
    if (!edit) return;
    setDraft(undefined);
    if (!props.applyEdits([edit], true)) setDraft(current);
  };

  const deleteEntry = (entry: DotenvEntry) => props.applyEdits([dotenvDeleteEdit(text(), entry)], true);

  const copyButton = (variable: () => DotenvVariable, index: number, part: CopyPart, label: string, text?: string) => (
    <button
      type="button"
      classList={{
        "icon-button": true,
        "env-copy": true,
        "env-copy-line": !!text,
        "env-copy-done": copied() === `${index}:${part}`,
      }}
      title={label}
      aria-label={`${label}: ${variable().key}`}
      onClick={() => void copy(variable(), index, part)}
    >
      <Icon name={copied() === `${index}:${part}` ? "check" : "copy"} size={14} />
      <Show when={text}>
        <span>{text}</span>
      </Show>
    </button>
  );

  const generatorPopup = (applyLabel: string, apply: () => void) => (
    <div
      class="env-popup env-generator"
      style={{ left: `${popupPosition().x}px`, top: `${popupPosition().y}px` }}
      role="dialog"
      aria-label={t("Generate random value")}
    >
      <strong>{t("Generate random value")}</strong>
      <label>
        {t("Format")}
        <select
          aria-label={t("Format")}
          value={options().format}
          onChange={(event) => updateOptions({ ...options(), format: event.currentTarget.value as SecretFormat })}
        >
          <option value="base64url">Base64URL</option>
          <option value="base64">Base64</option>
          <option value="hex">Hex</option>
          <option value="alphanumeric">{t("Alphanumeric")}</option>
          <option value="uuid">UUIDv4</option>
        </select>
      </label>
      <Show when={options().format !== "uuid"}>
        <label>
          {options().format === "alphanumeric" ? t("Length (characters)") : t("Length (bytes)")}
          <input
            type="number"
            min="1"
            max="1024"
            value={options().length}
            onChange={(event) => {
              const length = Math.max(1, Math.min(1024, Math.floor(Number(event.currentTarget.value) || 1)));
              event.currentTarget.value = String(length);
              updateOptions({ ...options(), length });
            }}
          />
        </label>
      </Show>
      <Show when={options().format !== "uuid"}>
        <div class="env-presets">
          <For each={[16, 32, 64]}>
            {(length) => (
              <button type="button" class="secondary-button" onClick={() => updateOptions({ ...options(), length })}>
                {length}
              </button>
            )}
          </For>
        </div>
      </Show>
      <label>
        {t("Preview")}
        <textarea readonly rows="3" value={preview()} aria-label={t("Preview")} />
      </label>
      <span class="env-output-length">{t("{count} characters", { count: preview().length })}</span>
      <div class="env-generator-actions">
        <button type="button" class="secondary-button" onClick={() => setPreview(generateSecret(options()))}>
          {t("Regenerate")}
        </button>
        <button
          type="button"
          class="secondary-button"
          onClick={() => void props.onCopy(preview(), t("Copied the generated value."))}
        >
          {t("Copy")}
        </button>
        <button type="button" class="secondary-button" onClick={() => closePopup(true)}>
          {t("Cancel")}
        </button>
        <button type="button" class="primary-button" onClick={apply}>
          {applyLabel}
        </button>
      </div>
    </div>
  );

  const variableRow = (variable: () => DotenvVariable, index: number) => (
    <div
      class="env-row"
      role="row"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        showMenu(
          index,
          event.clientX,
          event.clientY,
          document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget,
        );
      }}
    >
      <div class="env-cell" role="cell">
        <input
          class="env-input env-key"
          classList={{ "env-key-duplicate": variable().duplicate }}
          value={variable().key}
          placeholder={t("NAME")}
          spellcheck={false}
          autocomplete="off"
          aria-label={t("Variable name")}
          onInput={(event) => sanitizeKeyInput(event.currentTarget)}
          onChange={(event) => commitKey(variable(), event.currentTarget)}
        />
        {copyButton(variable, index, "name", t("Copy name"))}
      </div>
      <div class="env-cell" role="cell">
        <Show
          when={variable().value.includes("\n")}
          fallback={
            <input
              class="env-input env-value"
              value={variable().value}
              placeholder={t("value")}
              spellcheck={false}
              autocomplete="off"
              aria-label={t("Value of {key}", { key: variable().key })}
              onChange={(event) => commitValue(variable(), event.currentTarget)}
            />
          }
        >
          <textarea
            class="env-input env-value"
            rows={Math.min(variable().value.split("\n").length, 8)}
            value={variable().value}
            spellcheck={false}
            aria-label={t("Value of {key}", { key: variable().key })}
            onChange={(event) => commitValue(variable(), event.currentTarget)}
          />
        </Show>
        <button
          type="button"
          class="icon-button env-generate"
          title={t("Generate random value")}
          aria-label={t("Generate random value for {key}", { key: variable().key })}
          onClick={(event) => openGenerator(index, event.currentTarget)}
        >
          ✦
        </button>
        {copyButton(variable, index, "value", t("Copy value"))}
      </div>
      <div class="env-row-actions" role="cell">
        <Show when={variable().duplicate}>
          <span class="env-duplicate" title={t("This name appears more than once; most tools use the last one.")}>
            {t("Duplicate")}
          </span>
        </Show>
        {copyButton(variable, index, "line", t("Copy line"), t("Line"))}
        <div
          class="env-menu-wrap"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closePopup(true);
              event.stopPropagation();
            }
          }}
        >
          <button
            type="button"
            class="icon-button"
            aria-label={t("Actions for {key}", { key: variable().key })}
            aria-haspopup="menu"
            aria-expanded={menu() === index}
            onClick={(event) => {
              if (menu() === index) closePopup();
              else {
                const rect = event.currentTarget.getBoundingClientRect();
                showMenu(index, rect.right - 180, rect.bottom, event.currentTarget);
              }
            }}
          >
            ⋯
          </button>
          <Show when={menu() === index}>
            <div
              class="env-popup env-menu"
              style={{ left: `${popupPosition().x}px`, top: `${popupPosition().y}px` }}
              role="menu"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[(current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
              }}
            >
              <button
                type="button"
                class="secondary-button"
                role="menuitem"
                onClick={() => addVariable(index, "above")}
              >
                {t("Insert above")}
              </button>
              <button
                type="button"
                class="secondary-button"
                role="menuitem"
                onClick={() => addVariable(index, "below")}
              >
                {t("Insert below")}
              </button>
              <button type="button" class="secondary-button" role="menuitem" onClick={() => openGenerator(index)}>
                {t("Generate random value")}
              </button>
            </div>
          </Show>
          <Show when={generator() === index}>
            {generatorPopup(t("Apply"), () => {
              if (props.applyEdits([dotenvValueEdit(variable(), preview())], true)) closePopup(true);
            })}
          </Show>
        </div>
        <button
          type="button"
          class="icon-button env-delete"
          title={t("Delete variable")}
          aria-label={`${t("Delete variable")}: ${variable().key}`}
          onClick={() => deleteEntry(variable())}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );

  const draftRowView = () => (
    <div class="env-row env-draft" role="row" ref={draftRow} onFocusOut={finishDraft}>
      <div class="env-cell" role="cell">
        <input
          ref={draftKeyInput}
          class="env-input env-key"
          classList={{ "env-key-invalid": draftNeedsName() }}
          value={draft()?.key ?? ""}
          placeholder={t("NAME")}
          spellcheck={false}
          autocomplete="off"
          aria-label={t("Variable name")}
          aria-invalid={draftNeedsName()}
          onInput={(event) => {
            const key = sanitizeKeyInput(event.currentTarget);
            setDraft((current) => current && { ...current, key });
          }}
        />
      </div>
      <div class="env-cell" role="cell">
        <input
          class="env-input env-value"
          value={draft()?.value ?? ""}
          placeholder={t("value")}
          spellcheck={false}
          autocomplete="off"
          aria-label={t("Value")}
          onInput={(event) => setDraft((current) => current && { ...current, value: event.currentTarget.value })}
        />
        <div
          class="env-menu-wrap"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closePopup(true);
              event.stopPropagation();
            }
          }}
        >
          <button
            type="button"
            class="icon-button env-generate"
            title={t("Generate random value")}
            aria-label={t("Generate random value")}
            aria-haspopup="dialog"
            aria-expanded={generator() === DRAFT_GENERATOR}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (generator() === DRAFT_GENERATOR) closePopup(true);
              else openGenerator(DRAFT_GENERATOR, event.currentTarget);
            }}
          >
            ✦
          </button>
          <Show when={generator() === DRAFT_GENERATOR}>
            {generatorPopup(t("Apply"), () => {
              const value = preview();
              setDraft((current) => current && { ...current, value });
              closePopup(true);
            })}
          </Show>
        </div>
      </div>
      <div class="env-row-actions" role="cell">
        <button
          type="button"
          class="icon-button env-delete"
          title={t("Discard new variable")}
          aria-label={t("Discard new variable")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setDraft(undefined)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );

  const noteRow = (note: () => DotenvNote) => (
    <div classList={{ "env-row": true, "env-note": true, "env-comment": note().kind === "comment" }} role="row">
      <span role="cell">{note().kind === "comment" ? `# ${note().text}` : note().text}</span>
    </div>
  );

  return (
    <div
      classList={{ "env-table": true, "env-values-hidden": !valuesShown() }}
      onKeyDown={(event) => {
        if (
          generator() !== undefined ||
          menu() !== undefined ||
          draft() ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey
        )
          return;
        const key = event.key.toLowerCase();
        if (key !== "z" && key !== "y") return;
        event.preventDefault();
        event.stopPropagation();
        props.onHistory(key === "y" || event.shiftKey ? "redo" : "undo");
      }}
    >
      <div class="env-toolbar">
        <span class="env-count">
          {variableCount() === 1 ? t("1 variable") : t("{count} variables", { count: variableCount() })}
        </span>
        <div class="env-toolbar-actions">
          <div
            class="env-menu-wrap"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closePopup(true);
                event.stopPropagation();
              }
            }}
          >
            <button
              type="button"
              class="secondary-button env-generate"
              disabled={tooLarge()}
              aria-haspopup="dialog"
              aria-expanded={generator() === NEW_VARIABLE_GENERATOR}
              onClick={(event) => {
                if (generator() === NEW_VARIABLE_GENERATOR) closePopup();
                else openGenerator(NEW_VARIABLE_GENERATOR, event.currentTarget);
              }}
            >
              <span aria-hidden="true">✦</span>
              <span>{t("Generate key")}</span>
            </button>
            <Show when={generator() === NEW_VARIABLE_GENERATOR}>
              {generatorPopup(t("Add as variable"), () => {
                const value = preview();
                closePopup();
                addVariable(undefined, "below", value);
              })}
            </Show>
          </div>
          <button
            type="button"
            class="secondary-button"
            aria-pressed={valuesShown()}
            onClick={() => setValuesShown((shown) => !shown)}
          >
            {valuesShown() ? t("Hide values") : t("Show values")}
          </button>
          <button type="button" class="secondary-button" disabled={tooLarge()} onClick={() => addVariable()}>
            <Icon name="plus" size={14} />
            <span>{t("Add variable")}</span>
          </button>
        </div>
      </div>
      <Show
        when={!tooLarge()}
        fallback={
          <p class="env-empty">{t("This file is too large for the table view. Switch to Source to edit it.")}</p>
        }
      >
        <Show when={entries().length > 0 || draft()} fallback={<p class="env-empty">{t("No variables yet.")}</p>}>
          <div class="env-grid" role="table" aria-label={t("Environment variables")}>
            <div class="env-row env-header" role="row">
              <span role="columnheader">{t("Name")}</span>
              <span role="columnheader">{t("Value")}</span>
              <span role="columnheader" class="env-header-actions" />
            </div>
            <Index each={entries()}>
              {(entry, index) => (
                <>
                  <Show when={draft()?.index === index && draft()?.side === "above"}>{draftRowView()}</Show>
                  <Switch>
                    <Match when={entry().kind === "variable"}>
                      {variableRow(entry as () => DotenvVariable, index)}
                    </Match>
                    <Match when={entry().kind !== "variable"}>{noteRow(entry as () => DotenvNote)}</Match>
                  </Switch>
                  <Show when={draft()?.index === index && draft()?.side === "below"}>{draftRowView()}</Show>
                </>
              )}
            </Index>
            <Show when={draft()?.index === -1}>{draftRowView()}</Show>
          </div>
        </Show>
        <button type="button" class="secondary-button env-add-bottom" onClick={() => addVariable()}>
          <Icon name="plus" size={14} />
          <span>{t("Add variable")}</span>
        </button>
      </Show>
    </div>
  );
}
