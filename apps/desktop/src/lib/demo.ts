import type { DirectoryEntry, GitStatusResult, ReadFileResult } from "../types";
import { lineEndingMapForContent } from "./file-metadata";
import { contentFingerprint } from "./fingerprint";

export const demoWorkspace = "pude-demo";
const demoSamplesWorkspace = "pude-samples";

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
  "pude-demo/.env": {
    path: "pude-demo/.env",
    content: `# App\nAPP_NAME=pude-demo\nAPP_URL=http://localhost:5173\n\n# Database\nDATABASE_URL="postgres://demo:demo@localhost:5432/pude"\nexport API_TOKEN='demo-token-123' # not a real token\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 176,
  },
  "pude-samples/README.md": {
    path: "pude-samples/README.md",
    content: `# Samples\n\nA second demo project.\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 32,
  },
  "pude-samples/notes/ideas.md": {
    path: "pude-samples/notes/ideas.md",
    content: `# Ideas\n`,
    encoding: "utf-8",
    lineEnding: "lf",
    modifiedAt: Date.now(),
    size: 8,
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
    { name: ".env", path: "pude-demo/.env", kind: "file", size: 176 },
    { name: "README.md", path: "pude-demo/README.md", kind: "file", size: 155 },
    { name: "package.json", path: "pude-demo/package.json", kind: "file", size: 118 },
  ],
};

const demoSamplesTree: DirectoryEntry = {
  name: "pude-samples",
  path: demoSamplesWorkspace,
  kind: "directory",
  expanded: true,
  loaded: true,
  children: [
    {
      name: "notes",
      path: "pude-samples/notes",
      kind: "directory",
      expanded: false,
      loaded: true,
      children: [{ name: "ideas.md", path: "pude-samples/notes/ideas.md", kind: "file", size: 8 }],
    },
    { name: "README.md", path: "pude-samples/README.md", kind: "file", size: 32 },
  ],
};

const demoRoots = [demoTree, demoSamplesTree];

/** Browser tests set this key to open the second demo project in another tab. */
export function demoFolderToOpen(): string {
  return sessionStorage.getItem("pude-demo-open-folder") ?? demoWorkspace;
}

function findEntryBelow(entry: DirectoryEntry, path: string): DirectoryEntry | undefined {
  if (entry.path === path) return entry;
  for (const child of entry.children ?? []) {
    const found = findEntryBelow(child, path);
    if (found) return found;
  }
  return undefined;
}

export function findDemoEntry(path: string): DirectoryEntry | undefined {
  for (const root of demoRoots) {
    const found = findEntryBelow(root, path);
    if (found) return found;
  }
  return undefined;
}

export function findDemoParent(path: string): DirectoryEntry | undefined {
  return findDemoEntry(path.slice(0, path.lastIndexOf("/")));
}

function demoCopyName(entry: DirectoryEntry, attempt: number): string {
  if (attempt === 0) return entry.name;
  const suffix = attempt === 1 ? " copy" : ` copy ${attempt}`;
  const extensionStart = entry.kind === "directory" ? -1 : entry.name.lastIndexOf(".");
  return extensionStart > 0 ? `${entry.name.slice(0, extensionStart)}${suffix}${entry.name.slice(extensionStart)}` : `${entry.name}${suffix}`;
}

function cloneDemoEntry(entry: DirectoryEntry, path: string, name = entry.name): DirectoryEntry {
  const file = demoFiles[entry.path];
  if (file) demoFiles[path] = { ...file, path, identity: `demo:${path}` };
  return { ...entry, name, path, children: entry.children?.map((child) => cloneDemoEntry(child, `${path}/${child.name}`)) };
}

export function copyDemoPath(source: string, destinationDirectory: string): { path: string; skippedSpecialItems: number } {
  const entry = findDemoEntry(source);
  if (!entry) throw new Error("Unable to paste item. The copied item no longer exists.");
  const directory = findDemoEntry(destinationDirectory);
  if (directory?.kind !== "directory") throw new Error("Unable to paste item. The destination folder no longer exists.");
  if (entry.kind === "directory" && (destinationDirectory === source || destinationDirectory.startsWith(`${source}/`))) {
    throw new Error("Unable to paste item. A folder cannot be pasted into itself or one of its subfolders.");
  }
  const taken = new Set(directory.children?.map((child) => child.name));
  let attempt = 0;
  while (taken.has(demoCopyName(entry, attempt))) attempt += 1;
  const name = demoCopyName(entry, attempt);
  const path = `${destinationDirectory}/${name}`;
  directory.children = [...(directory.children ?? []), cloneDemoEntry(entry, path, name)];
  return { path, skippedSpecialItems: 0 };
}

function parentDemoPath(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const normalized = path.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  return index < 0 ? demoWorkspace : normalized.slice(0, index) || separator;
}

function demoBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function createDemoFile(path: string): void {
  if (findDemoEntry(path)) throw new Error("Unable to create file. The item already exists.");
  const parent = findDemoEntry(parentDemoPath(path));
  if (!parent || parent.kind !== "directory") throw new Error("Unable to create file. The parent folder no longer exists.");
  demoFiles[path] = { path, content: "", encoding: "utf-8", lineEnding: "lf", lineEndings: "", bom: false, modifiedAt: Date.now(), size: 0, fingerprint: contentFingerprint(""), identity: `demo:${path}` };
  parent.children = [...(parent.children ?? []), { name: demoBaseName(path), path, kind: "file", size: 0 }];
}

export function createDemoDirectory(path: string): void {
  if (findDemoEntry(path)) throw new Error("Unable to create folder. The item already exists.");
  const parent = findDemoEntry(parentDemoPath(path));
  if (!parent || parent.kind !== "directory") throw new Error("Unable to create folder. The parent folder no longer exists.");
  parent.children = [...(parent.children ?? []), { name: demoBaseName(path), path, kind: "directory", expanded: false, loaded: true, children: [] }];
}

export function deleteDemoPath(path: string): void {
  const parent = findDemoParent(path);
  if (!parent?.children) throw new Error("Unable to delete item. The item no longer exists.");
  const index = parent.children.findIndex((entry) => entry.path === path);
  if (index < 0) throw new Error("Unable to delete item. The item no longer exists.");
  parent.children.splice(index, 1);
  for (const filePath of Object.keys(demoFiles)) {
    if (filePath === path || filePath.startsWith(`${path}/`)) delete demoFiles[filePath];
  }
}

export function renameDemoPath(from: string, to: string): void {
  const entry = findDemoEntry(from);
  if (!entry) throw new Error("Unable to rename item. The file no longer exists.");
  const nextName = to.split(/[\\/]/).filter(Boolean).at(-1);
  if (!nextName) throw new Error("Unable to rename item. Enter a valid name.");
  const previousPath = entry.path;
  entry.name = nextName;
  entry.path = to;
  updateDemoDescendantPaths(entry, previousPath, to);
  for (const [path, file] of Object.entries(demoFiles)) {
    if (path !== previousPath && !path.startsWith(`${previousPath}/`)) continue;
    const nextPath = `${to}${path.slice(previousPath.length)}`;
    delete demoFiles[path];
    demoFiles[nextPath] = { ...file, path: nextPath };
  }
}

function updateDemoDescendantPaths(entry: DirectoryEntry, previousPath: string, nextPath: string) {
  for (const child of entry.children ?? []) {
    const childPath = child.path;
    child.path = `${nextPath}${childPath.slice(previousPath.length)}`;
    updateDemoDescendantPaths(child, childPath, child.path);
  }
}

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
