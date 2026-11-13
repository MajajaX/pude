import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// The startup bundle is the script index.html loads plus every file it imports statically. The
// build merges them into one file, because each file is a separate request through the app's
// asset handler. The size budget sits about 2% above the 249,808 bytes measured on 2026-11-13,
// and the file budget allows one file more than the one measured. Language files and code
// loaded on demand do not count. Raising a budget needs a pull request note on what was added
// to startup and why it cannot load on demand.
export const STARTUP_BUDGET_BYTES = 254_800;
export const STARTUP_FILES_BUDGET = 2;

/** The script of `<script type="module" src="…">` in the built index.html. */
async function entryFile(distDir) {
  const html = await readFile(join(distDir, "index.html"), "utf8");
  const source = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/?([^"]+)"/)?.[1];
  if (!source) throw new Error("No module script in index.html.");
  return source;
}

export async function measureStartupBundle(distDir) {
  const manifest = JSON.parse(await readFile(join(distDir, ".vite", "manifest.json"), "utf8"));
  const entry = await entryFile(distDir);
  const entryKey = Object.keys(manifest).find((key) => manifest[key].file === entry);
  if (!entryKey) throw new Error(`The entry ${entry} of index.html is not in the Vite manifest.`);
  const visited = new Set();
  const files = new Map();
  const visit = async (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing static dependency in manifest: ${key}`);
    const file = resolve(distDir, chunk.file);
    const local = relative(resolve(distDir), file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Chunk is outside the dist directory: ${chunk.file}`);
    }
    if (!files.has(file)) files.set(file, { file: chunk.file, bytes: (await stat(file)).size });
    for (const dependency of chunk.imports ?? []) await visit(dependency);
  };
  await visit(entryKey);
  return {
    entry,
    startupBytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0),
    files: [...files.values()],
  };
}

export function budgetFailures(result) {
  const failures = [];
  if (result.startupBytes > STARTUP_BUDGET_BYTES)
    failures.push(`Startup code ${result.startupBytes} > ${STARTUP_BUDGET_BYTES} bytes`);
  if (result.files.length > STARTUP_FILES_BUDGET)
    failures.push(`Startup files ${result.files.length} > ${STARTUP_FILES_BUDGET}`);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const defaultDist = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/dist");
    const result = await measureStartupBundle(process.argv[2] ?? defaultDist);
    const failures = budgetFailures(result);
    console.log(
      JSON.stringify(
        { ...result, budgets: { startupBytes: STARTUP_BUDGET_BYTES, files: STARTUP_FILES_BUDGET }, failures },
        null,
        2,
      ),
    );
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
