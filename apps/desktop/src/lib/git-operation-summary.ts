import { t } from "./i18n";

export const SUMMARY_LENGTH_LIMIT = 100;
const DIFFSTAT_LINE = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?\s*$/m;
const REF_UPDATE_LINE = /^\s*[+*=-]?\s*(?:[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}|\[[^\]]+\])\s.+$/m;

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function limitLine(line: string): string {
  return line.length > SUMMARY_LENGTH_LIMIT ? `${line.slice(0, SUMMARY_LENGTH_LIMIT - 1).trimEnd()}…` : line;
}

function diffstatSummary(output: string): string | undefined {
  const match = output.match(DIFFSTAT_LINE);
  if (!match) return undefined;
  const [, files, insertions, deletions] = match;
  const changes = [insertions && `+${insertions}`, deletions && `−${deletions}`].filter(Boolean).join(" ");
  const changedFiles = files === "1" ? t("1 file changed") : t("{count} files changed", { count: files });
  return changes ? t("{files}, {changes}", { files: changedFiles, changes }) : changedFiles;
}

function stderrSummary(stderr: string): string | undefined {
  if (/^Everything up-to-date$/m.test(stderr)) return t("Everything up to date");
  const refUpdate = stderr.match(REF_UPDATE_LINE)?.[0];
  return refUpdate && limitLine(refUpdate.trim().replace(/\s+/g, " "));
}

/**
 * One line that tells the user what a Git operation did. It condenses Git's own output; Git writes
 * some results, such as a push, only to standard error, so that is used when standard output is empty.
 */
export function summarizeGitOperation(action: string, output: string, stderr = ""): string {
  if (!output.trim()) return (stderr.trim() && stderrSummary(stderr)) || t("Git operation completed.");
  const first = firstLine(output);
  if (action === "pull") {
    if (first === "Already up to date.") return t("Already up to date.");
    const diffstat = diffstatSummary(output);
    if (diffstat) return diffstat;
  }
  return limitLine(first);
}
