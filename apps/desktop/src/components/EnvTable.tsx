import { Index, Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";
import { dotenvAppendEdit, dotenvDeleteEdit, dotenvKeyEdit, dotenvLine, dotenvValueEdit, parseDotenv, sanitizeDotenvKey } from "../lib/dotenv";
import type { DotenvEntry, DotenvNote, DotenvVariable } from "../lib/dotenv";
import type { PluginEditorEdit } from "../lib/plugin-editor-edits";
import "../styles/env-table.css";

export const ENV_TABLE_MAX_CHARS = 512 * 1024;

type CopyPart = "name" | "value" | "line";

type DraftVariable = { key: string; value: string };

type EnvTableProps = {
  revision: number;
  readText: () => string;
  applyEdits: (edits: readonly PluginEditorEdit[]) => boolean;
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

  // A new variable stays on screen until focus leaves its row with a name, which writes it to the file, or with nothing typed, which discards it.
  const [draft, setDraft] = createSignal<DraftVariable>();
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
    if (input.value !== variable.value && !props.applyEdits([dotenvValueEdit(variable, input.value)])) input.value = variable.value;
  };

  const addVariable = () => {
    if (!draft()) setDraft({ key: "", value: "" });
    draftKeyInput?.scrollIntoView({ block: "nearest" });
    draftKeyInput?.focus();
  };

  const draftNeedsName = () => !draft()?.key && !!draft()?.value.trim();

  // A draft with a value but no name stays open instead of writing a nameless `=value` line.
  const finishDraft = (event: FocusEvent) => {
    if (draftRow?.contains(event.relatedTarget as Node | null)) return;
    const current = draft();
    if (!current || (!current.key && !current.value.trim())) {
      setDraft(undefined);
      return;
    }
    const edit = dotenvAppendEdit(text(), current.key, current.value);
    if (edit && props.applyEdits([edit])) setDraft(undefined);
  };

  const deleteEntry = (entry: DotenvEntry) => props.applyEdits([dotenvDeleteEdit(text(), entry)]);

  const copyButton = (variable: () => DotenvVariable, index: number, part: CopyPart, label: string, text?: string) => (
    <button classList={{ "icon-button": true, "env-copy": true, "env-copy-line": !!text, "env-copy-done": copied() === `${index}:${part}` }} title={label} aria-label={`${label}: ${variable().key}`} onClick={() => void copy(variable(), index, part)}>
      <Icon name={copied() === `${index}:${part}` ? "check" : "copy"} size={14} />
      <Show when={text}><span>{text}</span></Show>
    </button>
  );

  const variableRow = (variable: () => DotenvVariable, index: number) => (
    <div class="env-row" role="row">
      <div class="env-cell" role="cell">
        <input class="env-input env-key" classList={{ "env-key-duplicate": variable().duplicate }} value={variable().key} placeholder={t("NAME")} spellcheck={false} autocomplete="off" aria-label={t("Variable name")} onInput={(event) => sanitizeKeyInput(event.currentTarget)} onChange={(event) => commitKey(variable(), event.currentTarget)} />
        {copyButton(variable, index, "name", t("Copy name"))}
      </div>
      <div class="env-cell" role="cell">
        <Show when={variable().value.includes("\n")} fallback={
          <input class="env-input env-value" value={variable().value} placeholder={t("value")} spellcheck={false} autocomplete="off" aria-label={t("Value of {key}", { key: variable().key })} onChange={(event) => commitValue(variable(), event.currentTarget)} />
        }>
          <textarea class="env-input env-value" rows={Math.min(variable().value.split("\n").length, 8)} value={variable().value} spellcheck={false} aria-label={t("Value of {key}", { key: variable().key })} onChange={(event) => commitValue(variable(), event.currentTarget)} />
        </Show>
        {copyButton(variable, index, "value", t("Copy value"))}
      </div>
      <div class="env-row-actions" role="cell">
        <Show when={variable().duplicate}><span class="env-duplicate" title={t("This name appears more than once; most tools use the last one.")}>{t("Duplicate")}</span></Show>
        {copyButton(variable, index, "line", t("Copy line"), t("Line"))}
        <button class="icon-button env-delete" title={t("Delete variable")} aria-label={`${t("Delete variable")}: ${variable().key}`} onClick={() => deleteEntry(variable())}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  );

  const draftRowView = () => (
    <div class="env-row env-draft" role="row" ref={draftRow} onFocusOut={finishDraft}>
      <div class="env-cell" role="cell">
        <input ref={draftKeyInput} class="env-input env-key" classList={{ "env-key-invalid": draftNeedsName() }} value={draft()?.key ?? ""} placeholder={t("NAME")} spellcheck={false} autocomplete="off" aria-label={t("Variable name")} aria-invalid={draftNeedsName()} onInput={(event) => { const key = sanitizeKeyInput(event.currentTarget); setDraft((current) => current && { ...current, key }); }} />
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
    <div class="env-table">
      <div class="env-toolbar">
        <span class="env-count">{variableCount() === 1 ? t("1 variable") : t("{count} variables", { count: variableCount() })}</span>
        <button class="secondary-button" disabled={tooLarge()} onClick={addVariable}><Icon name="plus" size={14} /><span>{t("Add variable")}</span></button>
      </div>
      <Show when={!tooLarge()} fallback={<p class="env-empty">{t("This file is too large for the table view. Switch to Source to edit it.")}</p>}>
        <Show when={entries().length > 0 || draft()} fallback={<p class="env-empty">{t("No variables yet.")}</p>}>
          <div class="env-grid" role="table" aria-label={t("Environment variables")}>
            <div class="env-row env-header" role="row">
              <span role="columnheader">{t("Name")}</span>
              <span role="columnheader">{t("Value")}</span>
              <span role="columnheader" class="env-header-actions" />
            </div>
            <Index each={entries()}>{(entry, index) => (
              <Switch>
                <Match when={entry().kind === "variable"}>{variableRow(entry as () => DotenvVariable, index)}</Match>
                <Match when={entry().kind !== "variable"}>{noteRow(entry as () => DotenvNote)}</Match>
              </Switch>
            )}</Index>
            <Show when={draft()}>{draftRowView()}</Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
