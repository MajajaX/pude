import { For, Show, createSignal } from "solid-js";
import { Icon } from "./Icons";
import { errorMessage } from "../lib/core";
import { splitDisplayPath } from "../lib/display-path";
import { relativeTimeLabel } from "../lib/relative-time";
import type { GitStash, GitStashFile } from "../types";
import { t } from "../lib/i18n";

type StashFilesState = { files?: GitStashFile[]; error?: string; loading?: boolean };

export function GitStashView(props: {
  stashes: GitStash[];
  busy: boolean;
  onLoadFiles: (stash: GitStash) => Promise<GitStashFile[]>;
  onOpenDiff: (stash: GitStash, file: GitStashFile) => void;
  onApply: (stash: GitStash) => void;
  onPop: (stash: GitStash) => void;
  onDrop: (stash: GitStash) => void;
}) {
  const [expandedHash, setExpandedHash] = createSignal<string>();
  // Stash commits never change, so their file lists stay valid for as long as the hash exists.
  const [filesByHash, setFilesByHash] = createSignal<Record<string, StashFilesState>>({});

  const loadFiles = async (stash: GitStash) => {
    const current = filesByHash()[stash.hash];
    if (current?.files || current?.loading) return;
    setFilesByHash((states) => ({ ...states, [stash.hash]: { loading: true } }));
    try {
      const files = await props.onLoadFiles(stash);
      setFilesByHash((states) => ({ ...states, [stash.hash]: { files } }));
    } catch (error) {
      setFilesByHash((states) => ({ ...states, [stash.hash]: { error: errorMessage(error, "Unable to load stash files.") } }));
    }
  };

  const toggle = (stash: GitStash) => {
    if (expandedHash() === stash.hash) {
      setExpandedHash(undefined);
      return;
    }
    setExpandedHash(stash.hash);
    void loadFiles(stash);
  };

  return (
    <div class="git-stash-list" role="list" aria-label={t("Stashes")}>
      <For each={props.stashes}>{(stash) => {
        const expanded = () => expandedHash() === stash.hash;
        const state = () => filesByHash()[stash.hash];
        return (
          <div class="git-stash" role="listitem">
            <div class="git-stash-row">
              <button class="git-stash-toggle" type="button" aria-expanded={expanded()} onClick={() => toggle(stash)} title={`${stash.reference}: ${stash.message}`}>
                <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={12} />
                <span class="git-stash-message">{stash.message}</span>
                <span class="git-stash-meta" title={stash.createdAt}>{stash.reference} · {relativeTimeLabel(stash.createdAt)}</span>
              </button>
              <div class="git-stash-actions">
                <button type="button" disabled={props.busy} onClick={() => props.onApply(stash)} title={t("Apply {reference} and keep it in the list", { reference: stash.reference })}>{t("Apply")}</button>
                <button type="button" disabled={props.busy} onClick={() => props.onPop(stash)} title={t("Apply {reference} and remove it from the list", { reference: stash.reference })}>{t("Pop")}</button>
                <button type="button" class="git-stash-drop" disabled={props.busy} onClick={() => props.onDrop(stash)} title={t("Delete {reference} without applying it", { reference: stash.reference })} aria-label={t("Drop {reference}", { reference: stash.reference })}><Icon name="trash" size={13} /></button>
              </div>
            </div>
            <Show when={expanded()}>
              <div class="git-stash-files">
                <Show when={state()?.loading}><div class="git-stash-state">{t("Loading changed files…")}</div></Show>
                <Show when={state()?.error}>{(message) => <div class="git-stash-state git-stash-error">{message()}<button type="button" onClick={() => { setFilesByHash((states) => ({ ...states, [stash.hash]: {} })); void loadFiles(stash); }}>{t("Retry")}</button></div>}</Show>
                <Show when={state()?.files?.length === 0}><div class="git-stash-state">{t("No changed files")}</div></Show>
                <For each={state()?.files}>{(file) => (
                  <button class="git-stash-file" type="button" onClick={() => props.onOpenDiff(stash, file)} title={t("Open the stashed change to {path}", { path: file.path })}>
                    <span class={`git-badge git-badge-${file.untracked ? "?" : file.status.slice(0, 1)}`} title={file.untracked ? t("Untracked file saved in the stash") : undefined}>{file.untracked ? "?" : file.status.slice(0, 1)}</span>
                    <span class="git-path"><span class="git-path-name">{splitDisplayPath(file.path).name}</span><span class="git-path-directory">{splitDisplayPath(file.path).directory}</span></span>
                  </button>
                )}</For>
              </div>
            </Show>
          </div>
        );
      }}</For>
    </div>
  );
}
