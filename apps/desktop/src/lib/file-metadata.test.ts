import { describe, expect, it } from "vitest";
import { EditorState, Compartment } from "@codemirror/state";
import { ensureSyntaxTree, language } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadEditorLanguageSupport, shouldLoadEditorLanguage } from "./editor-languages";
import { fileLanguageForPath, lineEndingFromMap, lineEndingMapForContent, normalizeDocumentContent, normalizeEditorDocumentSource, normalizeLineEndingMap, reconcileLineEndingMap, serializeDocumentBytes } from "./file-metadata";

describe("file metadata", () => {
  it("normalizes editor documents to LF", () => {
    expect(normalizeDocumentContent("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("uses matching trust versions to reuse canonical current and saved metadata", () => {
    const source = {
      content: "one\ntwo\nthree",
      lineEndings: "cl",
      contentVersion: 7,
      normalizedContentVersion: 7,
      savedContent: "one\ntwo\nthree",
      savedLineEndings: "cl",
      savedRevision: 4,
      normalizedSavedRevision: 4,
      lineEnding: "lf" as const,
    };

    expect(normalizeEditorDocumentSource(source)).toEqual({
      content: source.content,
      lineEndings: source.lineEndings,
      savedContent: source.savedContent,
      savedLineEndings: source.savedLineEndings,
      currentWasValidated: true,
      savedWasValidated: true,
    });
  });

  it("repairs stale current and saved version markers at the untrusted boundary", () => {
    const normalized = normalizeEditorDocumentSource({
      content: "one\r\ntwo\rthree",
      lineEndings: "xcl",
      contentVersion: 9,
      normalizedContentVersion: 8,
      savedContent: "old\rtext",
      savedLineEndings: "?",
      savedRevision: 5,
      normalizedSavedRevision: 4,
      lineEnding: "crlf",
    });

    expect(normalized).toEqual({
      content: "one\ntwo\nthree",
      lineEndings: "cl",
      savedContent: "old\ntext",
      savedLineEndings: "c",
      currentWasValidated: false,
      savedWasValidated: false,
    });
  });

  it("keeps mixed separators for unchanged lines and uses the preceding line for inserted lines", () => {
    const original = "alpha\nbeta\ngamma";
    const originalMap = "cl";
    expect(reconcileLineEndingMap(original, "alpha!\nbeta\ngamma", originalMap, "lf")).toBe("cl");
    expect(reconcileLineEndingMap(original, "alpha\ninserted\nbeta\ngamma", originalMap, "lf")).toBe("ccl");
    expect(reconcileLineEndingMap(original, "alpha\ngamma", originalMap, "lf")).toBe("c");
  });

  it("preserves separators for edits at the start, middle, end, and across repeated edits", () => {
    const original = "one\ntwo\nthree\nfour";
    const map = "clc";
    const atStart = reconcileLineEndingMap(original, "ONE\ntwo\nthree\nfour", map, "lf");
    const atMiddle = reconcileLineEndingMap("ONE\ntwo\nthree\nfour", "ONE\nTWO\nthree\nfour", atStart, "lf");
    const atEnd = reconcileLineEndingMap("ONE\nTWO\nthree\nfour", "ONE\nTWO\nthree\nFOUR", atMiddle, "lf");
    expect(atStart).toBe(map);
    expect(atMiddle).toBe(map);
    expect(atEnd).toBe(map);
  });

  it("uses the closest existing ending for lines added before or after a mixed-ending document", () => {
    const original = "alpha\nbeta\ngamma";
    const map = "lc";
    expect(reconcileLineEndingMap(original, "prefix\nalpha\nbeta\ngamma", map, "lf")).toBe("llc");
    expect(reconcileLineEndingMap(original, "alpha\nbeta\ngamma\nsuffix", map, "lf")).toBe("lcc");
  });

  it("handles BOM-only and unterminated documents without inventing separators", () => {
    expect(normalizeLineEndingMap("", "", "crlf")).toBe("");
    expect(reconcileLineEndingMap("", "text", "", "crlf")).toBe("");
    expect(reconcileLineEndingMap("text", "text\n", "", "crlf")).toBe("c");
  });

  it("uses the preferred ending when a new document has no neighbouring line", () => {
    expect(lineEndingMapForContent("one\ntwo", "crlf")).toBe("c");
    expect(reconcileLineEndingMap("", "one\ntwo", "", "crlf")).toBe("c");
    expect(lineEndingFromMap("clc", "lf")).toBe("crlf");
    expect(normalizeLineEndingMap("one\ntwo", undefined, "crlf")).toBe("c");
  });

  it("serializes document bytes with per-line separators, BOM, and no invented final separator", () => {
    const latin1 = (bytes: Uint8Array) => {
      let result = "";
      for (const byte of bytes) result += String.fromCharCode(byte);
      return result;
    };
    expect(latin1(serializeDocumentBytes("one\ntwo\nthree\n", "lcl", false))).toBe("one\ntwo\r\nthree\n");
    expect(latin1(serializeDocumentBytes("one\ntwo", "c", false))).toBe("one\r\ntwo");
    // Missing markers reuse the majority ending; a final unterminated line
    // never gains a separator.
    expect(latin1(serializeDocumentBytes("a\nb\n", "c", false))).toBe("a\r\nb\r\n");
    expect(latin1(serializeDocumentBytes("a\nb", "c", false))).toBe("a\r\nb");
    const withBom = serializeDocumentBytes("BOM text\n", "l", true);
    expect(Array.from(withBom.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(latin1(withBom.slice(3))).toBe("BOM text\n");
    // Mixed files round trip byte for byte through normalize + serialize.
    const mixedBytes = "one\r\ntwo\nthree\r\n";
    expect(latin1(serializeDocumentBytes(normalizeDocumentContent(mixedBytes), "clc", false))).toBe(mixedBytes);
  });

  it("uses extension metadata for labels and JavaScript variants", () => {
    expect(fileLanguageForPath("src/view.ts")).toMatchObject({ label: "TypeScript", key: "javascript", typescript: true });
    expect(fileLanguageForPath("src/view.tsx")).toMatchObject({ label: "TSX", key: "javascript", typescript: true, jsx: true });
    expect(fileLanguageForPath("src/view.jsx")).toMatchObject({ label: "JSX", key: "javascript", jsx: true });
    expect(fileLanguageForPath("README").label).toBe("Plain Text");
  });

  it.each([
    ["Main.java", "Java", "java"],
    ["main.c", "C", "c"],
    ["main.cpp", "C++", "cpp"],
    ["Program.cs", "C#", "csharp"],
    ["script.sh", "Shell", "sh"],
    ["settings.toml", "TOML", "toml"],
  ])("maps %s to %s with the %s icon", (path, label, icon) => {
    expect(fileLanguageForPath(path)).toMatchObject({ label, icon });
  });

  it("creates and switches CodeMirror support for every added language", async () => {
    const paths = ["Main.java", "main.c", "main.cpp", "Program.cs", "script.sh", "settings.toml"];
    const supports = await Promise.all(paths.map((path) => loadEditorLanguageSupport(fileLanguageForPath(path))));
    expect(supports.every((support) => support.language)).toBe(true);

    const compartment = new Compartment();
    let state = EditorState.create({ doc: "class Main {}", extensions: [compartment.of(supports[0].extension)] });
    expect(state.facet(language)?.name).toBe(supports[0].language.name);
    state = state.update({ effects: compartment.reconfigure(supports[5].extension) }).state;
    expect(state.facet(language)?.name).toBe(supports[5].language.name);
  });

  it.each([
    ["Main.java", "public class Main { int value = 1; }"] as const,
    ["main.c", "int main(void) { return 0; }"] as const,
    ["main.cpp", "#include <iostream>\nint main() { return 0; }"] as const,
    ["Program.cs", "class Program { static void Main() { } }"] as const,
    ["script.sh", "#!/bin/sh\nprintf \"%s\\n\" \"hello\""] as const,
    ["settings.toml", "[package]\nname = \"pude\"\nversion = \"1.0\""] as const,
  ])("parses and highlights %s", async (path, source) => {
    const support = await loadEditorLanguageSupport(fileLanguageForPath(path));
    const state = EditorState.create({ doc: source, extensions: [support.extension] });
    const tree = ensureSyntaxTree(state, state.doc.length, 1_000);
    expect(tree).not.toBeNull();

    let nodeCount = 0;
    tree?.iterate({ enter: () => { nodeCount += 1; } });
    expect(nodeCount).toBeGreaterThan(3);

    const styles: Array<{ from: number; to: number; classes: string }> = [];
    highlightTree(tree!, classHighlighter, (from, to, classes) => styles.push({ from, to, classes }));
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every(({ from, to, classes }) => to > from && classes.includes("tok-"))).toBe(true);
  });

  it("keeps large files in plain mode", () => {
    const metadata = fileLanguageForPath("Main.java");
    expect(shouldLoadEditorLanguage(metadata, false)).toBe(true);
    expect(shouldLoadEditorLanguage(metadata, true)).toBe(false);
    expect(shouldLoadEditorLanguage(fileLanguageForPath("README"), false)).toBe(false);
  });
});
