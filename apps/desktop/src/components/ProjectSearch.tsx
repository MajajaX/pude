import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { cancelProjectSearch, searchProject } from "../lib/project-search";
import { errorMessage } from "../lib/core";
import { splitDisplayPath } from "../lib/display-path";
import type { ProjectSearchMatch, ProjectSearchOptions, ProjectSearchResults } from "../lib/project-search";
import "../styles/project-search.css";

export function ProjectSearch(props: { workspace: string; onOpen: (match: ProjectSearchMatch, options: ProjectSearchOptions) => Promise<void>; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [mode, setMode] = createSignal<ProjectSearchOptions["mode"]>("content");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [includeIgnored, setIncludeIgnored] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [results, setResults] = createSignal<ProjectSearchResults>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [opening, setOpening] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => input.focus());

  createEffect(() => {
    const workspace = props.workspace;
    const options = { query: query(), mode: mode(), caseSensitive: caseSensitive(), includeIgnored: includeIgnored() };
    const isComposing = composing();
    setResults(undefined);
    setError(undefined);
    setBusy(false);
    if (!workspace || !options.query || isComposing) return;
    let current = true;
    let started = false;
    const requestId = crypto.randomUUID();
    setBusy(true);
    const timer = setTimeout(() => {
      started = true;
      void searchProject(workspace, options, requestId).then((result) => {
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
    try { await props.onOpen(match, { query: query(), mode: mode(), caseSensitive: caseSensitive(), includeIgnored: includeIgnored() }); }
    finally { setOpening(false); }
  };

  return <section class="project-search" aria-label="Search project">
    <div class="project-search-controls">
      <div class="project-search-modes" role="group" aria-label="Search type">
        <button type="button" aria-pressed={mode() === "content"} onClick={() => setMode("content")}>Text</button>
        <button type="button" aria-pressed={mode() === "files"} onClick={() => setMode("files")}>Files</button>
      </div>
      <div class="project-search-input">
        <Icon name="search" size={13} />
        <input ref={input} value={query()} disabled={!props.workspace} aria-label={mode() === "content" ? "Search project text" : "Search project files"} placeholder={mode() === "content" ? "Find text in project…" : "Find files by name or path…"} autocorrect="off" autocapitalize="off" spellcheck={false}
          onInput={(event) => setQuery(event.currentTarget.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); props.onClose(); } }} />
        <button type="button" aria-label="Match case" title="Match case" aria-pressed={caseSensitive()} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
      </div>
      <label class="project-search-ignored"><input type="checkbox" checked={includeIgnored()} onChange={(event) => setIncludeIgnored(event.currentTarget.checked)} />Include Git ignored files</label>
    </div>
    <div class="project-search-status" role="status">
      <Show when={busy()} fallback={<Show when={error()} fallback={<Show when={results()} fallback={props.workspace ? "Search across files in this project." : "Open a folder to search its files."}>{(result) => <>{result().matches.length}{result().truncated ? "+" : ""} {result().matches.length === 1 && !result().truncated ? "result" : "results"}{result().skippedFiles ? ` · ${result().skippedFiles} skipped` : ""}</>}</Show>}>{error()}</Show>}>Searching…</Show>
    </div>
    <Show when={results()?.truncated}><p class="project-search-notice">Search limit reached. Narrow your query to see more results.</p></Show>
    <Show when={results()?.skippedFiles}><p class="project-search-notice">Skipped binary, unsupported, unreadable, or large files (over 2 MiB).</p></Show>
    <div class="project-search-results" aria-label="Project search results" aria-busy={busy()}>
      <For each={results()?.matches}>{(match) => <button type="button" class="project-search-result" disabled={opening()} onClick={() => void openResult(match)} title={`${match.relativePath}${match.line ? `:${match.line}` : ""}`}>
        <span class="project-search-path"><Icon name="file-code" size={14} /><span class="project-search-name">{splitDisplayPath(match.relativePath).name}</span><span class="project-search-directory">{splitDisplayPath(match.relativePath).directory}</span><Show when={match.line}><span class="project-search-line">:{match.line}</span></Show></span>
        <Show when={match.preview}><span class="project-search-preview">{match.preview}</span></Show>
      </button>}</For>
      <Show when={results()?.matches.length === 0}><p class="project-search-notice">No matches found.</p></Show>
    </div>
  </section>;
}
