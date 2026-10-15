// Compares pude with Visual Studio Code on this Mac: app size on disk, launch
// time and memory with a folder open. Quit pude before running; VS Code runs
// with a fresh, throwaway profile so your own VS Code window can stay open.
//
// usage: node scripts/benchmark/compare-vscode.mjs [--pude <App.app>] [--vscode <App.app>]
//                                                  [--folder <dir>] [--runs <n>] [--settle <seconds>]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    pude: { type: "string", default: "/Applications/pude.app" },
    vscode: { type: "string", default: "/Applications/Visual Studio Code.app" },
    folder: { type: "string", default: resolve(here, "../..") },
    runs: { type: "string", default: "7" },
    settle: { type: "string", default: "15" },
  },
});

if (process.platform !== "darwin") throw new Error("This benchmark runs on macOS only.");

// VS Code keeps its IPC socket in the profile folder, and socket paths must stay
// under 104 characters, so the scratch folder lives directly in /tmp.
const scratch = mkdtempSync("/tmp/pude-bench-");
const measureTool = join(scratch, "measure-launch");
execFileSync("swiftc", ["-O", "-o", measureTool, join(here, "measure-launch.swift")], { stdio: "inherit" });

const editors = [
  { name: "pude", app: options.pude, args: [options.folder] },
  {
    name: "VS Code",
    app: options.vscode,
    args: [
      options.folder,
      "--user-data-dir", join(scratch, "vscode-data"),
      "--extensions-dir", join(scratch, "vscode-extensions"),
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
  },
];

function launchOnce(editor) {
  const output = execFileSync(measureTool, [editor.app, options.settle, ...editor.args], { encoding: "utf8" });
  return JSON.parse(output);
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function appVersion(app) {
  return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
}

function sizeOnDiskMB(app) {
  const kibibytes = Number(execFileSync("du", ["-sk", app], { encoding: "utf8" }).split("\t")[0]);
  return (kibibytes * 1024) / 1_000_000;
}

try {
  const runs = Number(options.runs);
  const results = new Map(editors.map((editor) => [editor.name, []]));

  console.log("Warming up both editors once...");
  for (const editor of editors) launchOnce(editor);

  for (let run = 1; run <= runs; run += 1) {
    for (const editor of editors) {
      const result = launchOnce(editor);
      results.get(editor.name).push(result);
      console.log(`run ${run}/${runs}  ${editor.name.padEnd(7)}  ${JSON.stringify(result)}`);
    }
  }

  const summary = editors.map((editor) => {
    const editorResults = results.get(editor.name);
    return {
      editor: `${editor.name} ${appVersion(editor.app)}`,
      "size on disk (MB)": sizeOnDiskMB(editor.app).toFixed(1),
      "window shown (ms)": median(editorResults.map((result) => result.windowMs)),
      "ready (ms)": median(editorResults.map((result) => result.readyMs)),
      "memory (MB)": median(editorResults.map((result) => result.memoryMB)).toFixed(1),
      processes: median(editorResults.map((result) => result.processes)),
    };
  });
  console.log(`\nMedian of ${runs} runs, folder: ${options.folder}`);
  console.table(summary);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
