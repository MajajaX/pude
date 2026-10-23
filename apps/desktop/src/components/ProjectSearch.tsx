import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { cancelProjectSearch, replaceInProjectFolders, replaceSummary, searchProjectFolders } from "../lib/project-search";
import { isTauri } from "../lib/bridge";
import { errorMessage } from "../lib/core";
import { splitDisplayPath } from "../lib/display-path";
import type { ProjectSearchMatch, ProjectSearchOptions, ProjectSearchResults } from "../lib/project-search";
import "../styles/project-search.css";
import { t } from "../lib/i18n";

type ConfirmationRequest = { title: string; message: string; confirmLabel: string; cancelLabel: string; destructive?: boolean };

export function ProjectSearch(props: {
  folders: string[];
  onOpen: (match: ProjectSearchMatch, options: ProjectSearchOptions) => Promise<void>;
  onConfirm: (request: ConfirmationRequest) => Promise<boolean>;
  /** Files with unsaved editor changes; replace never rewrites them. */
  unsavedPaths: () => string[];
  /** Locks the window while files are rewritten. */
  onBusy: (busy: boolean) => void;
  /** Reload open files and Git status after files changed on disk. */
  onReplaced: () => void;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [replaceOpen, setReplaceOpen] = createSignal(false);
  const [mode, setMode] = createSignal<ProjectSearchOptions["mode"]>("content");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [includeIgnored, setIncludeIgnored] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [results, setResults] = createSignal<ProjectSearchResults>();
  const [busy, setBusy] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [opening, setOpening] = createSignal(false);
  const [searchRevision, setSearchRevision] = createSignal(0);
  let input!: HTMLInputElement;
  let replaceInput: HTMLInputElement | undefined;
  onMount(() => input.focus());

  const resultCount = (result: ProjectSearchResults) => {
    const count = `${result.matches.length}${result.truncated ? "+" : ""}`;
    return result.matches.length === 1 && !result.truncated ? t("{count} result", { count }) : t("{count} results", { count });
  };
  const searchOptions = (): ProjectSearchOptions => ({ query: query(), mode: mode(), caseSensitive: caseSensitive(), includeIgnored: includeIgnored() });
  const canReplace = () => mode() === "content" && Boolean(results()?.matches.length) && !busy() && !replacing();

  createEffect(() => {
    const folders = props.folders;
    const options = searchOptions();
    const isComposing = composing();
    searchRevision();
    setResults(undefined);
    setError(undefined);
    setBusy(false);
    if (!folders.length || !options.query || isComposing) return;
    let current = true;
    let started = false;
    const requestId = crypto.randomUUID();
    setBusy(true);
    const timer = setTimeout(() => {
      started = true;
      void searchProjectFolders(folders, options, requestId, () => current).then((result) => {
        if (current) setResults(result);
      }).catch((error) => {
        if (current) setError(errorMessage(error, "Unable to search project."));
      }).finally(() => { if (current) setBusy(false); });
    }, 250);
    onCleanup(() => {
      current = false;
      clearTimeout(timer);
      if (started) void cancelProjectSearch(requestId).catch(() => undefined);
    });
  });

  const openResult = async (match: ProjectSearchMatch) => {
    if (opening()) return;
    setOpening(true);
    try { await props.onOpen(match, searchOptions()); }
    finally { setOpening(false); }
  };

  const replace = async (paths?: string[]) => {
    if (!canReplace()) return;
    if (!isTauri) {
      props.notify(t("Replacing across files is available in the desktop build."));
      return;
    }
    const options = searchOptions();
    const fileName = paths?.length === 1 ? splitDisplayPath(paths[0]).name : undefined;
    const confirmed = await props.onConfirm({
      title: fileName ? t("Replace in {fileName}?", { fileName }) : t("Replace in all files?"),
      message: t("Replace every “{query}” with “{replacement}” in {value}? Files with unsaved changes are skipped. Undo cannot reverse this change.", { query: options.query, replacement: replacement(), value: fileName ?? "every matching file of this project" }),
      confirmLabel: t("Replace"),
      cancelLabel: t("Cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setReplacing(true);
    props.onBusy(true);
    try {
      const result = await replaceInProjectFolders(props.folders, {
        query: options.query, replacement: replacement(), caseSensitive: options.caseSensitive, includeIgnored: options.includeIgnored,
        paths, skipPaths: props.unsavedPaths(),
      });
      props.onReplaced();
      props.notify(replaceSummary(result));
      if (result.changedFiles.length) setSearchRevision((revision) => revision + 1);
    } catch (error) {
      props.notify(errorMessage(error, "Unable to replace in the project."));
    } finally {
      props.onBusy(false);
      setReplacing(false);
    }
  };

  const toggleReplace = () => {
    const open = !replaceOpen();
    setReplaceOpen(open);
    if (open) {
      setMode("content");
      queueMicrotask(() => replaceInput?.focus());
    }
  };

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); props.onClose(); }
  };

  return <section class="project-search" aria-label={t("Search project")}>
    <div class="project-search-controls">
      <div class="project-search-top">
        <button type="button" class="project-search-replace-toggle" aria-pressed={replaceOpen()} aria-expanded={replaceOpen()} title={replaceOpen() ? t("Hide replace") : t("Show replace")} aria-label={t("Toggle replace")} onClick={toggleReplace}><Icon name={replaceOpen() ? "chevron-down" : "chevron-right"} size={13} /></button>
        <div class="project-search-modes" role="group" aria-label={t("Search type")}>
          <button type="button" aria-pressed={mode() === "content"} onClick={() => setMode("content")}>{t("Text")}</button>
          <button type="button" aria-pressed={mode() === "files"} onClick={() => { setMode("files"); setReplaceOpen(false); }}>{t("Files")}</button>
        </div>
      </div>
      <div class="project-search-input">
        <Icon name="search" size={13} />
        <input ref={input} value={query()} disabled={!props.folders.length} aria-label={mode() === "content" ? t("Search project text") : t("Search project files")} placeholder={mode() === "content" ? t("Find text in project…") : t("Find files by name or path…")} autocorrect="off" autocapitalize="off" spellcheck={false}
          onInput={(event) => setQuery(event.currentTarget.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onKeyDown={closeOnEscape} />
        <button type="button" aria-label={t("Match case")} title={t("Match case")} aria-pressed={caseSensitive()} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
      </div>
      <Show when={replaceOpen()}>
        <div class="project-search-replace">
          <div class="project-search-input">
            <Icon name="replace" size={13} />
            <input ref={replaceInput} value={replacement()} disabled={!props.folders.length} aria-label={t("Replace with")} placeholder={t("Replace with…")} autocorrect="off" autocapitalize="off" spellcheck={false}
              onInput={(event) => setReplacement(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void replace(); } else closeOnEscape(event); }} />
          </div>
          <button type="button" class="project-search-replace-all" disabled={!canReplace()} onClick={() => void replace()} title={t("Replace every match in the project (Enter)")}>{replacing() ? t("Replacing…") : t("Replace all")}</button>
        </div>
      </Show>
      <label class="project-search-ignored"><input type="checkbox" checked={includeIgnored()} onChange={(event) => setIncludeIgnored(event.currentTarget.checked)} />{t("Include Git ignored files")}</label>
    </div>
    <div class="project-search-status" role="status">
      <Show when={busy()} fallback={<Show when={error()} fallback={<Show when={results()} fallback={props.folders.length ? t("Search across files in this project.") : t("Open a folder to search its files.")}>{(result) => <>{resultCount(result())}{result().skippedFiles ? t(" · {count} skipped", { count: result().skippedFiles }) : ""}</>}</Show>}>{error()}</Show>}>{t("Searching…")}</Show>
    </div>
    <Show when={results()?.truncated}><p class="project-search-notice">{replaceOpen() ? t("Search limit reached. Narrow your query to see more results. Replace all still changes every matching file.") : t("Search limit reached. Narrow your query to see more results.")}</p></Show>
    <Show when={results()?.skippedFiles}><p class="project-search-notice">{t("Skipped binary, unsupported, unreadable, or large files (over 2 MiB).")}</p></Show>
    <div classList={{ "project-search-results": true, "project-search-results-replace": replaceOpen() && mode() === "content" }} aria-label={t("Project search results")} aria-busy={busy()}>
      <For each={results()?.matches}>{(match) => <div class="project-search-result-row">
        <button type="button" class="project-search-result" disabled={opening()} onClick={() => void openResult(match)} title={`${match.relativePath}${match.line ? `:${match.line}` : ""}`}>
          <span class="project-search-path"><Icon name="file-code" size={14} /><span class="project-search-name">{splitDisplayPath(match.relativePath).name}</span><span class="project-search-directory">{splitDisplayPath(match.relativePath).directory}</span><Show when={match.line}><span class="project-search-line">:{match.line}</span></Show></span>
          <Show when={match.preview}><span class="project-search-preview">{match.preview}</span></Show>
        </button>
        <Show when={replaceOpen() && mode() === "content"}>
          <button type="button" class="project-search-replace-file" disabled={!canReplace()} onClick={() => void replace([match.path])} title={t("Replace every match in {name}", { name: splitDisplayPath(match.relativePath).name })} aria-label={t("Replace every match in {relativePath}", { relativePath: match.relativePath })}><Icon name="replace" size={13} /></button>
        </Show>
      </div>}</For>
      <Show when={results()?.matches.length === 0}><p class="project-search-notice">{t("No matches found.")}</p></Show>
    </div>
  </section>;
}
