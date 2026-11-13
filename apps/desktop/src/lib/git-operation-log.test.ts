import { describe, expect, it } from "vitest";
import {
  GIT_OPERATION_LOG_LIMIT,
  GIT_OPERATION_RESPONSE_LIMIT,
  appendGitOperationLog,
  createGitOperationLogEntry,
  limitGitOperationResponse,
  type GitOperationRecord,
} from "./git-operation-log";

const record = (overrides: Partial<GitOperationRecord> = {}): GitOperationRecord => ({
  action: "push",
  ok: true,
  startedAt: 1_700_000_000_000,
  durationMs: 420,
  command: "git push",
  output: "",
  stderr: "",
  ...overrides,
});

describe("Git operation log", () => {
  it("lists the newest entry first and keeps 50 entries", () => {
    let entries: ReturnType<typeof appendGitOperationLog> | undefined;
    const created = Array.from({ length: GIT_OPERATION_LOG_LIMIT + 5 }, (_, index) =>
      createGitOperationLogEntry(record({ durationMs: index })),
    );
    for (const entry of created) entries = appendGitOperationLog(entries, entry);
    expect(entries).toHaveLength(GIT_OPERATION_LOG_LIMIT);
    expect(entries?.[0]).toBe(created.at(-1));
    expect(entries?.at(-1)).toBe(created[5]);
  });

  it("does not change the entries it was given", () => {
    const first = appendGitOperationLog(undefined, createGitOperationLogEntry(record()));
    const second = appendGitOperationLog(first, createGitOperationLogEntry(record()));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("gives every entry its own id", () => {
    expect(createGitOperationLogEntry(record()).id).not.toBe(createGitOperationLogEntry(record()).id);
  });

  it("keeps exactly what Git printed as the response", () => {
    const entry = createGitOperationLogEntry(
      record({
        action: "push",
        output: "",
        stderr: "To github.com:example/repo.git\n   1a2b3c4..5d6e7f8  main -> main",
      }),
    );
    expect(entry.summary).toBe("1a2b3c4..5d6e7f8 main -> main");
    expect(entry.response).toBe("To github.com:example/repo.git\n   1a2b3c4..5d6e7f8  main -> main");
    expect(entry.hasDetails).toBe(true);
  });

  it("joins standard output and standard error into the response", () => {
    const entry = createGitOperationLogEntry(
      record({ action: "pull", output: "Already up to date.", stderr: "From github.com:example/repo\n * branch main" }),
    );
    expect(entry.response).toBe("Already up to date.\nFrom github.com:example/repo\n * branch main");
    expect(entry.hasDetails).toBe(true);
  });

  it("has no details when the response is the single line the summary condenses", () => {
    expect(createGitOperationLogEntry(record({ action: "pull", output: "Already up to date." })).hasDetails).toBe(
      false,
    );
    expect(
      createGitOperationLogEntry(record({ action: "push", output: "", stderr: "Everything up-to-date" })).hasDetails,
    ).toBe(false);
  });

  it("has an empty response and no details when Git printed nothing", () => {
    const entry = createGitOperationLogEntry(record({ action: "add", output: "", stderr: "" }));
    expect(entry.summary).toBe("Git operation completed.");
    expect(entry.response).toBe("");
    expect(entry.hasDetails).toBe(false);
  });

  it("records a failure with its message and command", () => {
    const entry = createGitOperationLogEntry(
      record({ ok: false, output: "fatal: unable to access remote\nhint: check the network", stderr: undefined }),
    );
    expect(entry.ok).toBe(false);
    expect(entry.summary).toBe("fatal: unable to access remote");
    expect(entry.response).toBe("fatal: unable to access remote\nhint: check the network");
    expect(entry.command).toBe("git push");
  });

  it("keeps a response within the limit unchanged", () => {
    const response = "a".repeat(GIT_OPERATION_RESPONSE_LIMIT);
    expect(limitGitOperationResponse(response)).toBe(response);
  });

  it("truncates a response over 64 KiB and marks it", () => {
    const limited = limitGitOperationResponse("a".repeat(GIT_OPERATION_RESPONSE_LIMIT + 1000));
    expect(limited.startsWith("a".repeat(GIT_OPERATION_RESPONSE_LIMIT))).toBe(true);
    expect(limited.endsWith("[Response truncated at 64 KiB]")).toBe(true);
    expect(limited.length).toBeLessThan(GIT_OPERATION_RESPONSE_LIMIT + 100);
  });

  it("counts bytes and never splits a character", () => {
    const limited = limitGitOperationResponse("例".repeat(GIT_OPERATION_RESPONSE_LIMIT));
    const kept = limited.slice(0, limited.indexOf("\n"));
    expect(kept).toBe("例".repeat(Math.floor(GIT_OPERATION_RESPONSE_LIMIT / 3)));
    expect(limited).not.toContain("�");
  });
});
