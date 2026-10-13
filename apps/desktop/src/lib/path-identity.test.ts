import { describe, expect, it } from "vitest";
import {
  createPathIdentity,
  isSameOrDescendantPath,
  joinWirePath,
  pathComparisonKey,
  samePath,
  wireBasename,
  wireParentPath,
} from "./path-identity";

describe("path identity", () => {
  it("keeps display and wire spellings intact while deriving a lexical key", () => {
    const identity = createPathIdentity("/project/src///", { platform: "posix" });
    expect(identity).toEqual({
      displayPath: "/project/src///",
      wirePath: "/project/src///",
      comparisonKey: "/project/src",
      kind: "posix",
      platform: "posix",
      casePolicy: "sensitive",
    });
  });

  it("preserves POSIX backslashes, whitespace, Unicode, and case", () => {
    expect(pathComparisonKey("/project/a\\b/ 資料 é.ts ", { platform: "posix" })).toBe("/project/a\\b/ 資料 é.ts ");
    expect(pathComparisonKey("C:\\project\\file.ts", { platform: "posix" })).toBe("C:\\project\\file.ts");
    expect(samePath("/Project/file.ts", "/project/file.ts", { platform: "posix" })).toBe(false);
    expect(pathComparisonKey("", { platform: "posix" })).toBe("");
    expect(pathComparisonKey("/", { platform: "posix" })).toBe("/");
    expect(pathComparisonKey("//", { platform: "posix" })).toBe("//");
  });

  it("keeps Windows drive-relative and drive-rooted paths distinct", () => {
    expect(pathComparisonKey("C:folder\\file.ts", { platform: "windows" })).toBe("C:folder/file.ts");
    expect(pathComparisonKey("C:folder\\", { platform: "windows" })).toBe("C:folder");
    expect(pathComparisonKey("C:\\folder\\file.ts", { platform: "windows" })).toBe("C:/folder/file.ts");
    expect(pathComparisonKey("C:\\", { platform: "windows" })).toBe("C:/");
    expect(pathComparisonKey("C:/", { platform: "windows" })).toBe("C:/");
    expect(isSameOrDescendantPath("\\folder\\file.ts", "\\", { platform: "windows" })).toBe(true);
    expect(isSameOrDescendantPath("C:folder/file.ts", "C:", { platform: "windows" })).toBe(true);
    expect(isSameOrDescendantPath("C:/folder/file.ts", "C:", { platform: "windows" })).toBe(false);
    expect(isSameOrDescendantPath("C:folder/../other", "C:folder/../other", { platform: "windows" })).toBe(false);
    expect(samePath("C:folder/file.ts", "C:/folder/file.ts", { platform: "windows" })).toBe(false);
  });

  it("normalizes Windows separator forms without default case folding", () => {
    expect(pathComparisonKey("C:\\project\\src\\", { platform: "windows" })).toBe("C:/project/src");
    expect(pathComparisonKey("C:/project/src", { platform: "windows" })).toBe("C:/project/src");
    expect(samePath("C:/Project/file.ts", "c:\\Project\\file.ts", { platform: "windows" })).toBe(false);
    expect(samePath("C:/Project/file.ts", "c:\\Project\\file.ts", { platform: "windows", casePolicy: "insensitive" })).toBe(true);
  });

  it("preserves UNC server and share roots and joins relative wire paths", () => {
    expect(pathComparisonKey("\\\\server\\share\\", { platform: "windows" })).toBe("//server/share");
    expect(pathComparisonKey("//server/share/folder/", { platform: "windows" })).toBe("//server/share/folder");
    expect(isSameOrDescendantPath("\\\\server\\share\\folder\\file", "//server/share", { platform: "windows" })).toBe(true);
    expect(isSameOrDescendantPath("//server/share-other/file", "//server/share", { platform: "windows" })).toBe(false);
    expect(joinWirePath("C:\\repo", "src/main.ts", { platform: "windows" })).toBe("C:\\repo\\src\\main.ts");
    expect(joinWirePath("C:", "src/main.ts", { platform: "windows" })).toBe("C:src/main.ts");
    expect(joinWirePath("//", "src/main.ts", { platform: "posix" })).toBe("//src/main.ts");
    expect(joinWirePath("/repo", "src/main.ts", { platform: "posix" })).toBe("/repo/src/main.ts");
  });

  it("matches canonical Windows paths to dialog paths without changing their wire spelling", () => {
    const options = { platform: "windows" as const, casePolicy: "insensitive" as const };
    const path = "\\\\?\\C:\\project\\資料 folder\\alpha.txt";
    const identity = createPathIdentity(path, options);
    expect(identity.wirePath).toBe(path);
    expect(identity.displayPath).toBe(path);
    expect(samePath(path, "c:/project/資料 folder/alpha.txt", options)).toBe(true);
    expect(samePath("\\\\?\\UNC\\server\\share\\alpha.txt", "\\\\server\\share\\alpha.txt", options)).toBe(true);
    expect(isSameOrDescendantPath(path, "C:\\project", options)).toBe(true);
    expect(wireParentPath("\\\\?\\C:\\alpha.txt", options)).toBe("\\\\?\\C:\\");
    expect(wireParentPath("\\\\?\\UNC\\server\\share\\", options)).toBe("\\\\?\\UNC\\server\\share\\");
  });

  it("keeps verbatim-only names and device namespaces distinct from ordinary Windows paths", () => {
    const options = { platform: "windows" as const };
    for (const tail of ["name.", "name ", "CON.txt", "COM¹.txt", "..\\alpha.txt", "folder/alpha.txt"]) {
      const path = `\\\\?\\C:\\project\\${tail}`;
      expect(createPathIdentity(path, options).kind).toBe("windows-verbatim");
      expect(samePath(path, `C:\\project\\${tail}`, options)).toBe(false);
    }
    expect(createPathIdentity("\\\\?\\Volume{test}\\alpha.txt", options).kind).toBe("windows-verbatim");
    expect(createPathIdentity("\\\\?\\UNC\\server", options).kind).toBe("windows-verbatim");
    expect(isSameOrDescendantPath("\\\\?\\C:\\project\\..\\alpha.txt", "\\\\?\\C:\\project", options)).toBe(false);
    expect(samePath("\\\\?\\C:\\project\\name ", "\\\\?\\C:\\project\\name", options)).toBe(false);
  });

  it("derives POSIX basename and parent without treating backslashes as separators", () => {
    const posix = { platform: "posix" as const };
    expect(wireBasename("/repo/資料 folder/file.ts", posix)).toBe("file.ts");
    expect(wireBasename("/repo/valid\\name.ts", posix)).toBe("valid\\name.ts");
    expect(wireParentPath("/repo/valid\\name.ts", posix)).toBe("/repo");
    expect(wireParentPath("valid\\name.ts", posix)).toBe(".");
    expect(wireBasename("/", posix)).toBe("/");
    expect(wireParentPath("/", posix)).toBe("/");
    expect(wireParentPath("/name", posix)).toBe("/");
    expect(wireParentPath("//name", posix)).toBe("//");
    expect(wireBasename("", posix)).toBe("");
  });

  it("derives Windows drive and UNC components without losing root forms", () => {
    const windows = { platform: "windows" as const };
    expect(wireBasename("C:\\repo\\file.ts", windows)).toBe("file.ts");
    expect(wireParentPath("C:\\repo\\file.ts", windows)).toBe("C:\\repo");
    expect(wireParentPath("C:\\file.ts", windows)).toBe("C:\\");
    expect(wireBasename("C:\\", windows)).toBe("C:");
    expect(wireParentPath("C:\\", windows)).toBe("C:\\");
    expect(wireBasename("C:relative\\file.ts", windows)).toBe("file.ts");
    expect(wireParentPath("C:relative\\file.ts", windows)).toBe("C:relative");
    expect(wireParentPath("C:relative", windows)).toBe("C:");
    expect(wireBasename("\\\\server\\share\\folder\\file.ts", windows)).toBe("file.ts");
    expect(wireParentPath("\\\\server\\share\\folder\\file.ts", windows)).toBe("\\\\server\\share\\folder");
    expect(wireBasename("\\\\server\\share\\", windows)).toBe("share");
    expect(wireParentPath("\\\\server\\share\\", windows)).toBe("\\\\server\\share\\");
  });

  it("uses component boundaries and does not resolve dot segments", () => {
    expect(isSameOrDescendantPath("/repo/src/file.ts", "/repo", { platform: "posix" })).toBe(true);
    expect(isSameOrDescendantPath("/repository/file.ts", "/repo", { platform: "posix" })).toBe(false);
    expect(isSameOrDescendantPath("/repo/../outside", "/repo", { platform: "posix" })).toBe(false);
    expect(samePath("/repo/./file.ts", "/repo/file.ts", { platform: "posix" })).toBe(false);
    expect(samePath("/repo/link/../target", "/repo/target", { platform: "posix" })).toBe(false);
  });

  it("keeps URI-like application entries opaque", () => {
    expect(pathComparisonKey("pude://recent-projects/", { platform: "windows" })).toBe("pude://recent-projects/");
  });
});
