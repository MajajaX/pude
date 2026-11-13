import type { GitActionRequest } from "../types";
import { SUMMARY_LENGTH_LIMIT, summarizeGitOperation } from "./git-operation-summary";
import { t } from "./i18n";

export const GIT_OPERATION_LOG_LIMIT = 50;
export const GIT_OPERATION_RESPONSE_LIMIT = 64 * 1024;

export type GitOperationAction = GitActionRequest["action"] | "create-worktree";

export type GitOperationLogEntry = {
  id: number;
  action: GitOperationAction;
  ok: boolean;
  startedAt: number;
  durationMs: number;
  command?: string;
  summary: string;
  /** Standard output followed by standard error, or the error message of a failed operation. */
  response: string;
  /** Whether the response says more than the one line the summary condenses. */
  hasDetails: boolean;
};

export type GitOperationRecord = {
  action: GitOperationAction;
  ok: boolean;
  startedAt: number;
  durationMs: number;
  command?: string;
  output: string;
  stderr?: string;
};

let lastEntryId = 0;

export function limitGitOperationResponse(response: string): string {
  const bytes = new TextEncoder().encode(response);
  if (bytes.length <= GIT_OPERATION_RESPONSE_LIMIT) return response;
  const kept = new TextDecoder().decode(bytes.subarray(0, GIT_OPERATION_RESPONSE_LIMIT)).replace(/�$/, "");
  return `${kept}\n${t("[Response truncated at 64 KiB]")}`;
}

export function createGitOperationLogEntry(record: GitOperationRecord): GitOperationLogEntry {
  const response = [record.output, record.stderr].filter(Boolean).join("\n").trim();
  const lines = response.split(/\r?\n/).filter((line) => line.trim());
  return {
    id: ++lastEntryId,
    action: record.action,
    ok: record.ok,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    command: record.command,
    summary: summarizeGitOperation(record.action, record.output, record.stderr),
    response: limitGitOperationResponse(response),
    hasDetails: lines.length > 1 || (lines[0]?.trim().length ?? 0) > SUMMARY_LENGTH_LIMIT,
  };
}

export function appendGitOperationLog(
  entries: readonly GitOperationLogEntry[] | undefined,
  entry: GitOperationLogEntry,
): GitOperationLogEntry[] {
  return [entry, ...(entries ?? [])].slice(0, GIT_OPERATION_LOG_LIMIT);
}
