import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "./Icons";
import { gitActionLabel } from "../lib/git-action-labels";
import type { GitOperationLogEntry } from "../lib/git-operation-log";
import { locale, t, translateMessage } from "../lib/i18n";

function durationLabel(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function GitOperationLogView(props: {
  entries: GitOperationLogEntry[];
  expandedId?: number;
  onToggle: (id: number) => void;
}) {
  const [copyMessage, setCopyMessage] = createSignal("");
  let copyMessageTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyMessageTimer));

  const copyResponse = async (entry: GitOperationLogEntry) => {
    try {
      await navigator.clipboard.writeText(entry.response);
      setCopyMessage(t("Response copied"));
    } catch {
      setCopyMessage(t("Clipboard is unavailable"));
    }
    clearTimeout(copyMessageTimer);
    copyMessageTimer = setTimeout(() => setCopyMessage(""), 1800);
  };

  return (
    <Show when={props.entries.length} fallback={<div class="empty-git">{t("No Git operations have run yet.")}</div>}>
      <div class="git-log-list" role="list" aria-label={t("Git operation log")}>
        <For each={props.entries}>
          {(entry) => {
            const expanded = () => props.expandedId === entry.id;
            const startedAt = new Date(entry.startedAt);
            return (
              <div class="git-log-entry" role="listitem">
                <button
                  id={`git-log-entry-${entry.id}`}
                  class="git-log-toggle"
                  type="button"
                  aria-expanded={expanded()}
                  aria-controls={`git-log-details-${entry.id}`}
                  onClick={() => props.onToggle(entry.id)}
                >
                  <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={12} />
                  <span class="git-log-heading">
                    <span class={entry.ok ? "git-log-succeeded" : "git-log-failed"}>
                      <Icon name={entry.ok ? "check" : "close"} size={12} />
                      <span class="sr-only">{entry.ok ? t("Succeeded") : t("Failed")}</span>
                    </span>
                    <span class="git-log-action">{gitActionLabel(entry.action)}</span>
                    <span class="git-log-meta" title={startedAt.toLocaleString(locale())}>
                      {startedAt.toLocaleTimeString(locale())} · {durationLabel(entry.durationMs)}
                    </span>
                  </span>
                  <span class="git-log-summary">{translateMessage(entry.summary)}</span>
                </button>
                <Show when={expanded()}>
                  <div class="git-log-details" id={`git-log-details-${entry.id}`}>
                    <Show when={entry.command}>
                      <div class="git-log-command">
                        <span>{t("Command")}</span>
                        <code>{entry.command}</code>
                      </div>
                    </Show>
                    <Show when={entry.response} fallback={<div class="git-log-command">{t("(no output)")}</div>}>
                      <div class="git-log-response-heading">
                        <span>{entry.ok ? t("Response") : t("Error")}</span>
                        <button type="button" onClick={() => void copyResponse(entry)}>
                          {t("Copy")}
                        </button>
                      </div>
                      <div
                        classList={{ "git-log-response": true, "git-log-response-prose": !entry.ok }}
                        role="textbox"
                        aria-readonly="true"
                        aria-multiline="true"
                        tabIndex={0}
                        aria-label={t("Full response")}
                      >
                        {entry.response}
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="sr-only" role="status">
        {copyMessage()}
      </div>
    </Show>
  );
}
