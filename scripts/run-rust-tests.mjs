import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) {
    throw new Error(`expected a value after ${key ?? "argument"}`);
  }
  options.set(key.slice(2), value);
  index += 1;
}

const cargo = process.env.CARGO ?? "cargo";
const profile = options.get("profile") ?? "debug";
if (!["debug", "release"].includes(profile)) throw new Error("profile must be debug or release");
const profileArgs = profile === "release" ? ["--release"] : [];
const manifestPath = resolve(root, options.get("manifest-path") ?? "apps/desktop/src-tauri/Cargo.toml");
const workingDirectory = dirname(manifestPath);
const logPath = resolve(options.get("log-file") ?? resolve(root, "rust-test-diagnostics.log"));
const testTimeoutMs = Number(options.get("test-timeout-ms") ?? 60_000);
const buildTimeoutMs = Number(options.get("build-timeout-ms") ?? 1_800_000);
const listTimeoutMs = Number(options.get("list-timeout-ms") ?? 60_000);
const totalTimeoutMs = Number(options.get("total-timeout-ms") ?? 30 * 60_000);
const closeGraceMs = 5_000;
const maxCaptureBytes = 64 * 1024 * 1024;

if (![testTimeoutMs, buildTimeoutMs, listTimeoutMs, totalTimeoutMs].every((value) => Number.isInteger(value) && value > 0)) {
  throw new Error("timeout values must be positive integer milliseconds");
}

await mkdir(dirname(logPath), { recursive: true });
const logStream = createWriteStream(logPath, { flags: "w" });
let logQueue = Promise.resolve();
const failures = [];
let totalTests = 0;
let passedTests = 0;
let ignoredTests = 0;
let activeChild;
let cancelled = false;
let cancelSignal;
let cancellationCleanup;
let cancellationLogged = false;
const totalDeadline = Date.now() + totalTimeoutMs;

function handleCancellation(signal) {
  if (cancelled) return;
  cancelled = true;
  cancelSignal = signal;
  if (activeChild) cancellationCleanup = killTree(activeChild);
}

process.on("SIGINT", () => handleCancellation("SIGINT"));
process.on("SIGTERM", () => handleCancellation("SIGTERM"));

function ensureTimeRemaining(label) {
  if (cancelled) throw new Error(`cancelled by ${cancelSignal}`);
  const remainingMs = totalDeadline - Date.now();
  if (remainingMs <= 0) throw new Error(`overall diagnostics deadline of ${totalTimeoutMs} ms exceeded before ${label}`);
  return remainingMs;
}

function writeLog(content) {
  const chunk = Buffer.isBuffer(content) ? content : Buffer.from(content);
  process.stdout.write(chunk);
  logQueue = logQueue.then(() => new Promise((resolveWrite, rejectWrite) => {
    logStream.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()));
  }));
  return logQueue;
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(root, "scripts/kill-process-tree.ps1"),
      "-RootProcessId",
      String(child.pid),
    ], { encoding: "utf8", timeout: 4_000, windowsHide: true });
    if (killer.error) await writeLog(`[PROCESS CLEANUP] PowerShell tree cleanup reported: ${killer.error.message}\n`);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function run(command, args, { label, timeoutMs, captureStdout = false } = {}) {
  ensureTimeRemaining(label);
  await writeLog(`\n===== ${label} =====\n$ ${[command, ...args].join(" ")}\n`);
  const effectiveTimeoutMs = Math.min(timeoutMs, ensureTimeRemaining(label));
  const child = spawn(command, args, {
    cwd: workingDirectory,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeChild = child;
  let captured = "";
  let capturedBytes = 0;
  let captureOverflow = false;
  const capture = (chunk) => {
    if (!captureStdout || captureOverflow) return;
    if (capturedBytes + chunk.length > maxCaptureBytes) {
      captureOverflow = true;
      return;
    }
    captured += chunk.toString("utf8");
    capturedBytes += chunk.length;
  };
  child.stdout.on("data", (chunk) => {
    void writeLog(chunk);
    capture(chunk);
  });
  child.stderr.on("data", (chunk) => void writeLog(chunk));

  let deadline;
  let timedOut = false;
  const closePromise = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal, forcedClose: false }));
  });
  const timeoutPromise = new Promise((resolveTimeout) => {
    deadline = setTimeout(async () => {
      timedOut = true;
      const deadlineName = effectiveTimeoutMs < timeoutMs ? "the remaining overall diagnostics deadline" : `${timeoutMs} ms`;
      await writeLog(`\n[TIMEOUT] ${label} exceeded ${deadlineName}; terminating its process tree.\n`);
      await killTree(child);
      const closed = await Promise.race([
        closePromise.then((exit) => ({ exit })),
        new Promise((resolveGrace) => setTimeout(() => resolveGrace({ graceExpired: true }), closeGraceMs)),
      ]);
      if (closed.graceExpired) {
        await writeLog(`[TIMEOUT] ${label} did not close its output pipes within ${closeGraceMs} ms; forcing stream close.\n`);
        await killTree(child);
        child.stdout.destroy();
        child.stderr.destroy();
        try {
          child.kill("SIGKILL");
        } catch {}
        resolveTimeout({ code: child.exitCode, signal: child.signalCode, forcedClose: true });
      } else {
        resolveTimeout(closed.exit);
      }
    }, effectiveTimeoutMs);
  });

  let exit;
  try {
    exit = await Promise.race([closePromise, timeoutPromise]);
  } finally {
    clearTimeout(deadline);
    if (activeChild === child) activeChild = undefined;
  }

  if (cancelled) throw new Error(`cancelled by ${cancelSignal}`);
  if (captureOverflow) throw new Error(`${label} output exceeded ${maxCaptureBytes} bytes; see ${logPath}`);
  await writeLog(`\n[EXIT] ${label}: code=${exit.code ?? "null"}, signal=${exit.signal ?? "none"}${timedOut ? ", timed out" : ""}${exit.forcedClose ? ", pipes forcibly closed" : ""}\n`);
  return { ...exit, timedOut, stdout: captured };
}

async function finishLog() {
  await logQueue;
  const finished = once(logStream, "finish");
  logStream.end();
  await finished;
}

try {
  await writeLog(`Rust test diagnostics: ${new Date().toISOString()}\nManifest: ${manifestPath}\nProfile: ${profile}\nPer-test timeout: ${testTimeoutMs} ms\nTotal timeout: ${totalTimeoutMs} ms\n`);
  const metadataResult = await run(cargo, [
    "metadata",
    "--locked",
    "--manifest-path",
    manifestPath,
    "--no-deps",
    "--format-version",
    "1",
  ], { label: "inspect Cargo test targets", timeoutMs: listTimeoutMs, captureStdout: true });
  if (metadataResult.code !== 0 || metadataResult.timedOut) throw new Error("Cargo metadata failed or timed out");
  const metadata = JSON.parse(metadataResult.stdout);
  const packageInfo = metadata.packages.find((candidate) => resolve(candidate.manifest_path) === manifestPath);
  if (!packageInfo) throw new Error(`Cargo metadata omitted ${manifestPath}`);
  const hasDoctests = packageInfo.targets.some((target) => target.doctest === true);

  const build = await run(cargo, [
    "test",
    "--locked",
    ...profileArgs,
    "--manifest-path",
    manifestPath,
    "--no-run",
    "--message-format=json",
  ], { label: "compile test binaries", timeoutMs: buildTimeoutMs, captureStdout: true });
  if (build.code !== 0 || build.timedOut) throw new Error("Cargo test compilation failed or timed out");

  const executables = new Set();
  for (const line of build.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const message = JSON.parse(line);
      if (message.reason === "compiler-artifact" && message.profile?.test === true && message.executable) {
        executables.add(message.executable);
      }
    } catch {}
  }
  if (executables.size === 0) throw new Error("Cargo did not report any compiled test executables");

  for (const executable of [...executables].sort()) {
    const listing = await run(executable, ["--list", "--format", "terse"], {
      label: `list ${basename(executable)}`,
      timeoutMs: listTimeoutMs,
      captureStdout: true,
    });
    if (listing.code !== 0 || listing.timedOut) {
      failures.push(`${basename(executable)} test listing failed`);
      continue;
    }
    const testNames = listing.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^(.+): test(?:\s|$)/)?.[1])
      .filter(Boolean);
    for (const testName of testNames) {
      totalTests += 1;
      const result = await run(executable, ["--exact", testName, "--nocapture", "--test-threads=1"], {
        label: `test ${testName}`,
        timeoutMs: testTimeoutMs,
        captureStdout: true,
      });
      const summary = result.stdout.match(/test result: \S+\. (\d+) passed; (\d+) failed; (\d+) ignored;/);
      if (result.timedOut || result.code !== 0 || !summary) {
        failures.push(`${testName}${result.timedOut ? " timed out" : ` exited with ${result.code ?? "an invalid test summary"}`}`);
      } else if (Number(summary[3]) > 0 && Number(summary[1]) === 0) {
        ignoredTests += 1;
        await writeLog(`[IGNORED] ${testName}\n`);
      } else if (Number(summary[1]) === 1 && Number(summary[2]) === 0) {
        passedTests += 1;
      } else {
        failures.push(`${testName} did not run exactly one test: ${summary[0]}`);
      }
    }
  }

  await writeLog(`\n===== Rust unit/integration test result =====\nDiscovered: ${totalTests}\nPassed: ${passedTests}\nIgnored: ${ignoredTests}\nFailed: ${failures.length}\n`);
  if (totalTests === 0) throw new Error("No Rust unit or integration tests were discovered");
  if (failures.length > 0) {
    for (const failure of failures) await writeLog(`FAIL: ${failure}\n`);
    throw new Error(`${failures.length} Rust test(s) failed; complete diagnostics: ${logPath}`);
  }

  if (hasDoctests) {
    const doctests = await run(cargo, [
      "test",
      "--locked",
      ...profileArgs,
      "--manifest-path",
      manifestPath,
      "--doc",
      "--",
      "--test-threads=1",
    ], { label: "documentation tests (bounded suite deadline)", timeoutMs: buildTimeoutMs });
    if (doctests.code !== 0 || doctests.timedOut) {
      throw new Error(`Rust documentation tests failed or timed out; complete diagnostics: ${logPath}`);
    }
  } else {
    await writeLog("\nNo Rust documentation-test target exists; skipped cargo test --doc.\n");
  }

  await writeLog(`\nNon-ignored Rust tests passed; ${ignoredTests} test(s) were ignored. Complete diagnostics: ${logPath}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (cancelled) {
    await writeLog(`\n[CANCELLED] ${message}\n`);
    cancellationLogged = true;
    process.exitCode = cancelSignal === "SIGINT" ? 130 : 143;
  } else {
    console.error(`run-rust-tests: ${message}`);
    process.exitCode = 1;
  }
} finally {
  await cancellationCleanup;
  if (cancelled && !cancellationLogged) {
    await writeLog(`\n[CANCELLED] Diagnostics interrupted by ${cancelSignal}.\n`);
  }
  if (cancelled) process.exitCode = cancelSignal === "SIGINT" ? 130 : 143;
  await finishLog();
}
