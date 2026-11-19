import { afterEach, describe, expect, it } from "vitest";
import { summarizeGitOperation } from "./git-operation-summary";
import { applyLanguage } from "./i18n";

const fastForwardPull = [
  "Updating 1a2b3c4..5d6e7f8",
  "Fast-forward",
  " src/a.ts | 4 ++--",
  " src/b.ts | 10 ++++++++++",
  " 2 files changed, 10 insertions(+), 2 deletions(-)",
].join("\n");
const pullFetchLog = "From github.com:example/repo\n   1a2b3c4..5d6e7f8  main       -> origin/main";
const pushUpdate = ["To github.com:example/repo.git", "   1a2b3c4..5d6e7f8  main -> main"].join("\n");
const pushNewBranch = [
  "remote: ",
  "remote: Create a pull request for 'feature' on GitHub by visiting:",
  "remote:      https://github.com/example/repo/pull/new/feature",
  "remote: ",
  "To github.com:example/repo.git",
  " * [new branch]      feature -> feature",
  "branch 'feature' set up to track 'origin/feature'.",
].join("\n");
const commit = "[main 5d6e7f8] Add the log\n 1 file changed, 3 insertions(+)\n create mode 100644 log.ts";

afterEach(() => applyLanguage("en"));

describe("Git operation summaries", () => {
  it("summarizes a fast-forward pull by its diffstat", () => {
    expect(summarizeGitOperation("pull", fastForwardPull, pullFetchLog)).toBe("2 files changed, +10 −2");
  });

  it("keeps a pull that is up to date short", () => {
    expect(summarizeGitOperation("pull", "Already up to date.\n", "")).toBe("Already up to date.");
  });

  it("handles one file, only insertions and only deletions", () => {
    expect(summarizeGitOperation("pull", " 1 file changed, 1 insertion(+)")).toBe("1 file changed, +1");
    expect(summarizeGitOperation("pull", " 3 files changed, 7 deletions(-)")).toBe("3 files changed, −7");
    expect(summarizeGitOperation("pull", " 1 file changed, 1 deletion(-)")).toBe("1 file changed, −1");
    expect(summarizeGitOperation("pull", " 4 files changed")).toBe("4 files changed");
  });

  it("falls back to the first line of a pull without a diffstat", () => {
    expect(summarizeGitOperation("pull", "\nSuccessfully rebased and updated refs/heads/main.\n")).toBe(
      "Successfully rebased and updated refs/heads/main.",
    );
  });

  it("uses the first line of a commit", () => {
    expect(summarizeGitOperation("commit", commit)).toBe("[main 5d6e7f8] Add the log");
    expect(summarizeGitOperation("commit-all", commit)).toBe("[main 5d6e7f8] Add the log");
  });

  it("uses the first non-empty line of other output", () => {
    expect(summarizeGitOperation("stash", "\n  \nSaved working directory and index state\nHEAD is now at abc")).toBe(
      "Saved working directory and index state",
    );
  });

  it("summarizes a push from the ref update on standard error", () => {
    expect(summarizeGitOperation("push", "", pushUpdate)).toBe("1a2b3c4..5d6e7f8 main -> main");
  });

  it("summarizes a push that creates a branch despite the remote lines", () => {
    expect(summarizeGitOperation("push", "", pushNewBranch)).toBe("* [new branch] feature -> feature");
  });

  it("summarizes a push with nothing to send", () => {
    expect(summarizeGitOperation("push", "", "Everything up-to-date")).toBe("Everything up to date");
  });

  it("reports completion when nothing recognizable was printed", () => {
    expect(summarizeGitOperation("add", " \n", "")).toBe("Git operation completed.");
    expect(summarizeGitOperation("switch", "", "Switched to branch 'topic'")).toBe("Git operation completed.");
  });

  it("caps a long line with an ellipsis", () => {
    const summary = summarizeGitOperation("stash", "x".repeat(300));
    expect(summary).toHaveLength(100);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarizeGitOperation("stash", "y".repeat(100))).toBe("y".repeat(100));
  });

  it("translates the summaries it generates and leaves Git's own text alone", async () => {
    await applyLanguage("zh-Hant");
    expect(summarizeGitOperation("pull", " 5 files changed, 20 insertions(+), 3 deletions(-)")).toBe(
      "5 個檔案變更，+20 −3",
    );
    expect(summarizeGitOperation("pull", " 1 file changed, 1 insertion(+)")).toBe("1 個檔案變更，+1");
    expect(summarizeGitOperation("pull", "Already up to date.")).toBe("已是最新");
    expect(summarizeGitOperation("push", "", "Everything up-to-date")).toBe("已是最新");
    expect(summarizeGitOperation("push", "", pushUpdate)).toBe("1a2b3c4..5d6e7f8 main -> main");
    expect(summarizeGitOperation("commit", commit)).toBe("[main 5d6e7f8] Add the log");
  });
});
