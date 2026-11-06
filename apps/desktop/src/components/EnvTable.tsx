import { For, Index, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";
import { dotenvAppendEdit, dotenvInsertEdit, dotenvDeleteEdit, dotenvKeyEdit, dotenvLine, dotenvValueEdit, parseDotenv, sanitizeDotenvKey } from "../lib/dotenv";
import type { DotenvEntry, DotenvNote, DotenvVariable } from "../lib/dotenv";
import { generateSecret, readSecretOptions, saveSecretOptions } from "../lib/random-secret";
import type { SecretFormat, SecretOptions } from "../lib/random-secret";
import type { PluginEditorEdit } from "../lib/plugin-editor-edits";
import "../styles/env-table.css";

export const ENV_TABLE_MAX_CHARS = 512 * 1024;

type CopyPart = "name" | "value" | "line";

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
  const entries = createMemo(() => tooLarge() ? [] : parseDotenv(text()));
  const variableCount = () => entries().filter((entry) => entry.kind === "variable").length;

  const [copied, setCopied] = createSignal<string>();
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  // A new variable stays on screen only until focus leaves its row; it is written to the file only if it has a name or value.
  const [draft, setDraft] = createSignal<DraftVariable>();
  const [menu, setMenu] = createSignal<number>();
  const [generator, setGenerator] = createSignal<number>();
  const [popupPosition, setPopupPosition] = createSignal({ x: 0, y: 0 });
  let popupTrigger: HTMLElement | null = null;
  const closePopup = (restore = false) => { setMenu(undefined); setGenerator(undefined); if (restore) popupTrigger?.focus(); };
  const showMenu = (index: number, x: number, y: number, trigger: HTMLElement) => {
    popupTrigger = trigger; setGenerator(undefined); setPopupPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 200)), y: Math.max(8, Math.min(y, window.innerHeight - 130)) }); setMenu(index);
    queueMicrotask(() => document.querySelector<HTMLButtonElement>(".env-menu button")?.focus());
  };
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element).closest(".env-menu-wrap, .env-generate")) closePopup(); };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });
  const [options, setOptions] = createSignal<SecretOptions>(readSecretOptions());
  const [preview, setPreview] = createSignal("");
  const updateOptions = (next: SecretOptions) => { setOptions(next); saveSecretOptions(next); setPreview(generateSecret(next)); };
  const openGenerator = (index: number, trigger?: HTMLElement) => { if (trigger) popupTrigger = trigger; const rect = (trigger ?? popupTrigger)?.getBoundingClientRect(); if (rect) setPopupPosition({ x: Math.max(8, Math.min(rect.right - 340, window.innerWidth - 350)), y: Math.max(8, Math.min(rect.bottom, window.innerHeight - 350)) }); setMenu(undefined); setGenerator(index); setPreview(generateSecret(options())); queueMicrotask(() => document.querySelector<HTMLSelectElement>(".env-generator select")?.focus()); };
  let draftRow: HTMLDivElement | undefined;
  let draftKeyInput: HTMLInputElement | undefined;

  const copy = async (variable: DotenvVariable, index: number, part: CopyPart) => {
    const value = part === "name" ? variable.key : part === "value" ? variable.value : dotenvLine(text(), variable);
    const message = part === "name" ? t("Copied the name {key}.", { key: variable.key })
      : part === "value" ? t("Copied the value of {key}.", { key: variable.key })
      : t("Copied the line {key}=….", { key: variable.key });
    if (!await props.onCopy(value, message)) return;
    clearTimeout(copiedTimer);
    setCopied(`${index}:${part}`);
    copiedTimer = setTimeout(() => setCopied(undefined), 1200);
  };

  const editKey = (variable: DotenvVariable, input: HTMLInputElement) => {
    const key = sanitizeDotenvKey(input.value);
    if (key !== input.value) input.value = key;
    if (key !== variable.key && !props.applyEdits([dotenvKeyEdit(variable, key)])) input.value = variable.key;
  };

  const editValue = (variable: DotenvVariable, input: HTMLInputElement | HTMLTextAreaElement) => {
    if (input.value !== variable.value && !props.applyEdits([dotenvValueEdit(variable, input.value)])) input.value = variable.value;
  };

  const addVariable = (index?: number, side: "above" | "below" = "below") => {
    const list = entries();
    const last = list.map((entry) => entry.kind).lastIndexOf("variable");
    if (!draft()) setDraft({ key: "", value: "", index: index ?? last, side });
    setMenu(undefined);
    queueMicrotask(() => { draftKeyInput?.scrollIntoView({ block: "nearest" }); draftKeyInput?.focus(); });
  };

  const editDraftKey = (input: HTMLInputElement) => {
    const key = sanitizeDotenvKey(input.value);
    if (key !== input.value) input.value = key;
    setDraft((current) => current && { ...current, key });
  };

  const finishDraft = (event: FocusEvent) => {
    if (draftRow?.contains(event.relatedTarget as Node | null)) return;
    const current = draft();
    setDraft(undefined);
    if (!current || (!current.key && !current.value.trim())) return;
    if (!props.applyEdits([current.index >= 0 && entries()[current.index] ? dotenvInsertEdit(text(), entries()[current.index], current.side, current.key, current.value) : dotenvAppendEdit(text(), current.key, current.value)], true)) setDraft(current);
  };

  const deleteEntry = (entry: DotenvEntry) => props.applyEdits([dotenvDeleteEdit(text(), entry)], true);

  const copyButton = (variable: () => DotenvVariable, index: number, part: CopyPart, label: string, text?: string) => (
    <button classList={{ "icon-button": true, "env-copy": true, "env-copy-line": !!text, "env-copy-done": copied() === `${index}:${part}` }} title={label} aria-label={`${label}: ${variable().key}`} onClick={() => void copy(variable(), index, part)}>
      <Icon name={copied() === `${index}:${part}` ? "check" : "copy"} size={14} />
      <Show when={text}><span>{text}</span></Show>
    </button>
  );

  const variableRow = (variable: () => DotenvVariable, index: number) => (
    <div class="env-row" role="row" onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); showMenu(index, event.clientX, event.clientY, document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget); }}>
      <div class="env-cell" role="cell">
        <input class="env-input env-key" classList={{ "env-key-duplicate": variable().duplicate }} value={variable().key} placeholder={t("NAME")} spellcheck={false} autocomplete="off" aria-label={t("Variable name")} onInput={(event) => editKey(variable(), event.currentTarget)} />
        {copyButton(variable, index, "name", t("Copy name"))}
      </div>
      <div class="env-cell" role="cell">
        <Show when={variable().value.includes("\n")} fallback={
          <input class="env-input env-value" value={variable().value} placeholder={t("value")} spellcheck={false} autocomplete="off" aria-label={t("Value of {key}", { key: variable().key })} onInput={(event) => editValue(variable(), event.currentTarget)} />
        }>
          <textarea class="env-input env-value" rows={Math.min(variable().value.split("\n").length, 8)} value={variable().value} spellcheck={false} aria-label={t("Value of {key}", { key: variable().key })} onInput={(event) => editValue(variable(), event.currentTarget)} />
        </Show>
        <button class="icon-button env-generate" title={t("Generate random value")} aria-label={t("Generate random value for {key}", { key: variable().key })} onClick={(event) => openGenerator(index, event.currentTarget)}>✦</button>
        {copyButton(variable, index, "value", t("Copy value"))}
      </div>
      <div class="env-row-actions" role="cell">
        <Show when={variable().duplicate}><span class="env-duplicate" title={t("This name appears more than once; most tools use the last one.")}>{t("Duplicate")}</span></Show>
        {copyButton(variable, index, "line", t("Copy line"), t("Line"))}
        <div class="env-menu-wrap" onKeyDown={(event) => { if (event.key === "Escape") { closePopup(true); event.stopPropagation(); } }}>
          <button class="icon-button" aria-label={t("Actions for {key}", { key: variable().key })} aria-haspopup="menu" aria-expanded={menu() === index} onClick={(event) => { if (menu() === index) closePopup(); else { const rect = event.currentTarget.getBoundingClientRect(); showMenu(index, rect.right - 180, rect.bottom, event.currentTarget); } }}>⋯</button>
          <Show when={menu() === index}><div class="env-popup env-menu" style={{ left: `${popupPosition().x}px`, top: `${popupPosition().y}px` }} role="menu" onKeyDown={(event) => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll("button")); const current = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }}>
            <button class="secondary-button" role="menuitem" onClick={() => addVariable(index, "above")}>{t("Insert above")}</button>
            <button class="secondary-button" role="menuitem" onClick={() => addVariable(index, "below")}>{t("Insert below")}</button>
            <button class="secondary-button" role="menuitem" onClick={() => openGenerator(index)}>{t("Generate random value")}</button>
          </div></Show>
          <Show when={generator() === index}><div class="env-popup env-generator" style={{ left: `${popupPosition().x}px`, top: `${popupPosition().y}px` }} role="dialog" aria-label={t("Generate random value")}>
            <strong>{t("Generate random value")}</strong>
            <label>{t("Format")}<select aria-label={t("Format")} value={options().format} onChange={(event) => updateOptions({ ...options(), format: event.currentTarget.value as SecretFormat })}>
              <option value="base64url">Base64URL</option><option value="base64">Base64</option><option value="hex">Hex</option><option value="alphanumeric">{t("Alphanumeric")}</option><option value="uuid">UUIDv4</option>
            </select></label>
            <Show when={options().format !== "uuid"}><label>{options().format === "alphanumeric" ? t("Length (characters)") : t("Length (bytes)")}
              <input type="number" min="1" max="1024" value={options().length} onChange={(event) => { const length = Math.max(1, Math.min(1024, Math.floor(Number(event.currentTarget.value) || 1))); event.currentTarget.value = String(length); updateOptions({ ...options(), length }); }} />
            </label></Show>
            <Show when={options().format !== "uuid"}><div class="env-presets"><For each={[16, 32, 64]}>{(length) => <button class="secondary-button" onClick={() => updateOptions({ ...options(), length })}>{length}</button>}</For></div></Show>
            <label>{t("Preview")}<textarea readonly rows="3" value={preview()} aria-label={t("Preview")} /></label>
            <span class="env-output-length">{t("{count} characters", { count: preview().length })}</span>
            <div class="env-generator-actions"><button class="secondary-button" onClick={() => setPreview(generateSecret(options()))}>{t("Regenerate")}</button><button class="secondary-button" onClick={() => closePopup(true)}>{t("Cancel")}</button><button class="primary-button" onClick={() => { if (props.applyEdits([dotenvValueEdit(variable(), preview())], true)) closePopup(true); }}>{t("Apply")}</button></div>
          </div></Show>
        </div>
        <button class="icon-button env-delete" title={t("Delete variable")} aria-label={`${t("Delete variable")}: ${variable().key}`} onClick={() => deleteEntry(variable())}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  );

  const draftRowView = () => (
    <div class="env-row env-draft" role="row" ref={draftRow} onFocusOut={finishDraft}>
      <div class="env-cell" role="cell">
        <input ref={draftKeyInput} class="env-input env-key" value={draft()?.key ?? ""} placeholder={t("NAME")} spellcheck={false} autocomplete="off" aria-label={t("Variable name")} onInput={(event) => editDraftKey(event.currentTarget)} />
      </div>
      <div class="env-cell" role="cell">
        <input class="env-input env-value" value={draft()?.value ?? ""} placeholder={t("value")} spellcheck={false} autocomplete="off" aria-label={t("Value")} onInput={(event) => setDraft((current) => current && { ...current, value: event.currentTarget.value })} />
      </div>
      <div class="env-row-actions" role="cell">
        <button class="icon-button env-delete" title={t("Discard new variable")} aria-label={t("Discard new variable")} onMouseDown={(event) => event.preventDefault()} onClick={() => setDraft(undefined)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  );

  const noteRow = (note: () => DotenvNote) => (
    <div classList={{ "env-row": true, "env-note": true, "env-comment": note().kind === "comment" }} role="row">
      <span role="cell">{note().kind === "comment" ? `# ${note().text}` : note().text}</span>
    </div>
  );

  return (
    <div class="env-table" onKeyDown={(event) => {
      if (generator() !== undefined || menu() !== undefined || draft() || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault(); event.stopPropagation();
      props.onHistory(key === "y" || event.shiftKey ? "redo" : "undo");
    }}>
      <div class="env-toolbar">
        <span class="env-count">{variableCount() === 1 ? t("1 variable") : t("{count} variables", { count: variableCount() })}</span>
        <button class="secondary-button" disabled={tooLarge()} onClick={() => addVariable()}><Icon name="plus" size={14} /><span>{t("Add variable")}</span></button>
      </div>
      <Show when={!tooLarge()} fallback={<p class="env-empty">{t("This file is too large for the table view. Switch to Source to edit it.")}</p>}>
        <Show when={entries().length > 0 || draft()} fallback={<p class="env-empty">{t("No variables yet.")}</p>}>
          <div class="env-grid" role="table" aria-label={t("Environment variables")}>
            <div class="env-row env-header" role="row">
              <span role="columnheader">{t("Name")}</span>
              <span role="columnheader">{t("Value")}</span>
              <span role="columnheader" class="env-header-actions" />
            </div>
            <Index each={entries()}>{(entry, index) => (<>
              <Show when={draft()?.index === index && draft()?.side === "above"}>{draftRowView()}</Show>
              <Switch>
                <Match when={entry().kind === "variable"}>{variableRow(entry as () => DotenvVariable, index)}</Match>
                <Match when={entry().kind !== "variable"}>{noteRow(entry as () => DotenvNote)}</Match>
              </Switch>
              <Show when={draft()?.index === index && draft()?.side === "below"}>{draftRowView()}</Show>
            </>)}</Index>
            <Show when={draft()?.index === -1}>{draftRowView()}</Show>
          </div>
        </Show>
        <button class="secondary-button env-add-bottom" onClick={() => addVariable()}><Icon name="plus" size={14} /><span>{t("Add variable")}</span></button>
      </Show>
    </div>
  );
}
