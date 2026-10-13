import type { DirectoryEntry, GitStatusResult, ReadFileResult } from "../types";
import { lineEndingMapForContent } from "./file-metadata";
import { contentFingerprint } from "./fingerprint";

export const demoWorkspace = "pude-demo";

const demoFileSeeds: Record<string, Omit<ReadFileResult, "lineEndings" | "bom" | "fingerprint" | "identity">> = {
  "pude-demo/src/main.ts": {
    path: "pude-demo/src/main.ts",
    content: `import { createSignal } from "solid-js";\n\nconst [ready, setReady] = createSignal(false);\n\nexport function bootstrap() {\n  setReady(true);\n  console.log("pude is ready", ready());\n}\n\nbootstrap();\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 210,
  },
  "pude-demo/src/editor.ts": {
    path: "pude-demo/src/editor.ts",
    content: `export type EditorMode = "source" | "diff";\n\nexport function openDocument(path: string) {\n  return { path, mode: "source" as EditorMode };\n}\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 148,
  },
  "pude-demo/src/styles.css": {
    path: "pude-demo/src/styles.css",
    content: `:root {\n  color-scheme: dark;\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n\n.editor-shell {\n  min-height: 100vh;\n}\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 134,
  },
  "pude-demo/README.md": {
    path: "pude-demo/README.md",
    content: `# pude\n\npude is a pure code editor: local files, clear Git visibility, and no background noise.\n\n- Open a folder\n- Edit source files\n- Keep the runtime quiet\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 155,
  },
  "pude-demo/package.json": {
    path: "pude-demo/package.json",
    content: `{\n  "name": "pude-demo",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 118,
  },
};

export const demoFiles: Record<string, ReadFileResult> = Object.fromEntries(Object.entries(demoFileSeeds).map(([path, file]) => [path, {
  ...file,
  lineEndings: lineEndingMapForContent(file.content, file.lineEnding),
  bom: false,
  size: new TextEncoder().encode(file.content).byteLength,
  fingerprint: contentFingerprint(file.content),
  identity: `demo:${path}`,
}]));

export const demoTree: DirectoryEntry = {
  name: "pude-demo",
  path: demoWorkspace,
  kind: "directory",
  expanded: true,
  loaded: true,
  children: [
    {
      name: "src",
      path: "pude-demo/src",
      kind: "directory",
      expanded: true,
      loaded: true,
      children: [
        { name: "main.ts", path: "pude-demo/src/main.ts", kind: "file", size: 210 },
        { name: "editor.ts", path: "pude-demo/src/editor.ts", kind: "file", size: 148 },
        { name: "styles.css", path: "pude-demo/src/styles.css", kind: "file", size: 134 },
      ],
    },
    {
      name: "assets",
      path: "pude-demo/assets",
      kind: "directory",
      expanded: false,
      loaded: true,
      children: [{ name: "pude-logo.webp", path: "pude-demo/assets/pude-logo.webp", kind: "file" }],
    },
    { name: "README.md", path: "pude-demo/README.md", kind: "file", size: 155 },
    { name: "package.json", path: "pude-demo/package.json", kind: "file", size: 118 },
  ],
};

export const demoGit: GitStatusResult = {
  repositoryRoot: demoWorkspace,
  branch: "main",
  files: [
    { path: "src/main.ts", indexStatus: null, worktreeStatus: "M" },
    { path: "src/editor.ts", indexStatus: "A", worktreeStatus: null },
    { path: "notes/todo.md", indexStatus: null, worktreeStatus: "?" },
  ],
  commits: [
    {
      hash: "7d8c9a1f3b2c4d5e6f708192a3b4c5d6e7f8091a",
      parents: ["3a5e8c0b2d4f6a8c1e3f5b7d9a0c2e4f6b8d1a3c"],
      shortHash: "7d8c9a1",
      author: "pude",
      date: "2026-09-11",
      subject: "Refine the editor workspace",
      refs: ["HEAD -> main"],
      files: [
        { path: "src/main.ts", status: "M" },
        { path: "src/editor.ts", status: "A" },
      ],
    },
    {
      hash: "4c2f7d0e8a6b1c3d5e7f90123456789abcdef012",
      parents: ["3a5e8c0b2d4f6a8c1e3f5b7d9a0c2e4f6b8d1a3c"],
      shortHash: "4c2f7d0",
      author: "pude",
      date: "2026-09-10",
      subject: "Add editor tabs",
      refs: ["feature/editor-tabs"],
      files: [{ path: "src/editor.ts", status: "A" }],
    },
    {
      hash: "3a5e8c0b2d4f6a8c1e3f5b7d9a0c2e4f6b8d1a3c",
      parents: [],
      shortHash: "3a5e8c0",
      author: "pude",
      date: "2026-09-09",
      subject: "Keep the runtime quiet",
      refs: [],
      files: [{ path: "README.md", status: "M" }, { path: "src/styles.css", status: "M" }],
    },
  ],
};

export function demoDiff(path: string): string {
  if (path === "src/editor.ts") {
    return `diff --git a/src/editor.ts b/src/editor.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/editor.ts\n@@ -0,0 +1,6 @@\n+export type EditorMode = "source" | "diff";\n+\n+export function openDocument(path: string) {\n+  return { path, mode: "source" as EditorMode };\n+}\n`;
  }
  if (path === "src/main.ts") {
    return `diff --git a/src/main.ts b/src/main.ts\nindex 7d8c9a1..f0b4a12 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,10 +1,10 @@\n import { createSignal } from "solid-js";\n \n-const [ready, setReady] = createSignal(true);\n+const [ready, setReady] = createSignal(false);\n \n export function bootstrap() {\n   setReady(true);\n   console.log("pude is ready", ready());\n }\n \n bootstrap();\n`;
  }
  if (path === "notes/todo.md") {
    return `diff --git a/notes/todo.md b/notes/todo.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/todo.md\n@@ -0,0 +1,2 @@\n+# Todo\n+Review the workspace\n`;
  }
  return `diff --git a/${path} b/${path}\nindex 7d8c9a1..f0b4a12 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,5 +1,7 @@\n import { createSignal } from "solid-js";\n \n-const [ready, setReady] = createSignal(false);\n+const [ready, setReady] = createSignal(true);\n \n export function bootstrap() {\n+  console.log("pude workspace ready");\n   setReady(true);\n`;
}

export function demoCommitDiff(path: string): string {
  if (path === "src/editor.ts") return demoDiff(path);
  return `diff --git a/${path} b/${path}\nindex 4c1a2f0..7d8c9a1 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,5 @@\n existing content\n+workspace refinement\n`;
}

// `defaultSettings` lives in ./settings so the browser-demo data in
// this module can be loaded lazily (it is only needed when `!isTauri`).
export { defaultSettings } from "./settings";
