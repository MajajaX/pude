import { describe, expect, it } from "vitest";
import { canAddToGitignore } from "./add-to-gitignore";

const windows = { platform: "windows", casePolicy: "insensitive" } as const;

describe("canAddToGitignore", () => {
  it("accepts items inside the repository", () => {
    expect(canAddToGitignore("/repo/src/app.log", "/repo")).toBe(true);
    expect(canAddToGitignore("/repo/.github", "/repo")).toBe(true);
  });

  it("refuses the repository itself, its .git folder and outside items", () => {
    expect(canAddToGitignore("/repo", "/repo")).toBe(false);
    expect(canAddToGitignore("/repo/.git", "/repo")).toBe(false);
    expect(canAddToGitignore("/repo/.git/config", "/repo")).toBe(false);
    expect(canAddToGitignore("/other/file", "/repo")).toBe(false);
  });

  it("is unavailable outside a repository", () => {
    expect(canAddToGitignore("/repo/file", "")).toBe(false);
  });

  it("compares Windows paths without regard to case or separators", () => {
    expect(canAddToGitignore("c:\\Repo\\src\\a.txt", "C:/repo", windows)).toBe(true);
    expect(canAddToGitignore("C:/repo/.GIT/config", "C:\\repo", windows)).toBe(false);
  });
});
