import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryBase = resolve(tmpdir());
const temporaryPrefix = "pude-release-tooling-selftest-";
const temporaryDirectory = await mkdtemp(join(temporaryBase, "pude-release-tooling-selftest-"));
const skippedTests = [];

function isWithin(parent, candidate) {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function assertTemporaryRoot() {
  const absolute = resolve(temporaryDirectory);
  assert.ok(isWithin(temporaryBase, absolute), `self-test fixture root is outside the system temp directory: ${absolute}`);
  assert.ok(basename(absolute).startsWith(temporaryPrefix), `self-test fixture root has an unexpected name: ${absolute}`);
  assert.notEqual(absolute, root, "self-test must never write into the repository root");
}

function assertTemporaryPath(path) {
  const absolute = resolve(path);
  assert.notEqual(absolute, root, "self-test must never write into the repository root");
  assert.ok(isWithin(temporaryDirectory, absolute),
    `self-test path is outside its isolated temporary fixture: ${absolute}`);
}

function run(command, args, { cwd = root, env = process.env, timeout = 20_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

function expectSuccess(result, label) {
  assert.equal(result.error, undefined, `${label} did not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label} failed:\n${result.output}`);
}

function expectFailure(result, label, expectedText) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  if (expectedText) assert.ok(result.output.includes(expectedText), `${label} did not report '${expectedText}':\n${result.output}`);
}

function writeExecutable(path, contents) {
  return writeFile(path, contents, { mode: 0o700 }).then(() => chmod(path, 0o700));
}

async function testRunner() {
  if (process.platform === "win32") {
    skippedTests.push("Fake Cargo/harness process-tree tests require Unix executable scripts and process handling.");
    return null;
  }
  const fixture = join(temporaryDirectory, "rust-runner");
  assertTemporaryPath(fixture);
  await mkdir(fixture, { recursive: true });
  const harness = join(fixture, "fake-test-harness.mjs");
  const cargo = join(fixture, "fake-cargo.mjs");
  const logFile = join(fixture, "runner.log");
  const orphanPidFile = join(fixture, "orphan.pid");

  await writeExecutable(harness, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--list") {
  process.stdout.write("pass_case: test\\nignore_case: test\\nfail_case: test\\nhang_case: test\\n");
  process.exit(0);
}
const testName = args[args.indexOf("--exact") + 1];
if (testName === "pass_case") {
  process.stdout.write("test pass_case ... ok\\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.01s\\n");
  process.exit(0);
}
if (testName === "ignore_case") {
  process.stdout.write("test ignore_case ... ignored\\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 3 filtered out; finished in 0.00s\\n");
  process.exit(0);
}
if (testName === "fail_case") {
  process.stdout.write("test fail_case ... FAILED\\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.01s\\n");
  process.exit(101);
}
if (testName === "hang_case") {
  const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
  writeFileSync(process.env.ORPHAN_PID_FILE, String(orphan.pid));
  process.exit(0);
}
process.exit(2);
`);
  await writeExecutable(cargo, `#!/usr/bin/env node
import { resolve } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "metadata") {
  const manifestIndex = args.indexOf("--manifest-path");
  process.stdout.write(JSON.stringify({ packages: [{ manifest_path: resolve(args[manifestIndex + 1]), targets: [{ doctest: false }] }] }) + "\\n");
  process.exit(0);
}
if (args[0] === "test" && args.includes("--no-run")) {
  process.stdout.write(JSON.stringify({ reason: "compiler-artifact", profile: { test: true }, executable: process.env.FAKE_TEST_BINARY }) + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake cargo command\\n");
process.exit(2);
`);

  const result = run(process.execPath, [
    join(root, "scripts/run-rust-tests.mjs"),
    "--manifest-path", join(root, "apps/desktop/src-tauri/Cargo.toml"),
    "--log-file", logFile,
    "--test-timeout-ms", "250",
    "--build-timeout-ms", "2000",
    "--list-timeout-ms", "2000",
  ], {
    env: { ...process.env, CARGO: cargo, FAKE_TEST_BINARY: harness, ORPHAN_PID_FILE: orphanPidFile },
    timeout: 15_000,
  });
  expectFailure(result, "fake Rust test runner", "2 Rust test(s) failed");
  const log = await readFile(logFile, "utf8");
  assert.match(log, /Discovered: 4/);
  assert.match(log, /Passed: 1/);
  assert.match(log, /Ignored: 1/);
  assert.match(log, /Failed: 2/);
  assert.match(log, /\[IGNORED\] ignore_case/);
  assert.match(log, /hang_case timed out/);
  const orphanPid = Number(await readFile(orphanPidFile, "utf8"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(orphanPid, 0);
      await new Promise((done) => setTimeout(done, 50));
    } catch (error) {
      if (error?.code === "ESRCH") return "Rust test runner bounds test subprocesses, kills orphaned pipe holders, serializes diagnostics, and reports ignored/failing cases.";
      throw error;
    }
  }
  throw new Error(`orphaned fake test child ${orphanPid} remained after timeout cleanup`);
}

async function testChecksums() {
  const artifacts = join(temporaryDirectory, "checksums");
  assertTemporaryPath(artifacts);
  await mkdir(artifacts, { recursive: true });
  const first = join(artifacts, "candidate-one.bin");
  const second = join(artifacts, "candidate-two.bin");
  const manifest = join(artifacts, "SHA256SUMS.txt");
  await writeFile(first, "candidate one payload");
  await writeFile(second, "candidate two payload");
  expectSuccess(run(process.execPath, [join(root, "scripts/write-checksums.mjs"), "create", manifest, first, second]), "checksum create+verify");
  expectSuccess(run(process.execPath, [join(root, "scripts/write-checksums.mjs"), "verify", manifest, artifacts]), "checksum verify");
  await writeFile(first, "tampered payload");
  expectFailure(run(process.execPath, [join(root, "scripts/write-checksums.mjs"), "verify", manifest, artifacts]), "tampered checksum input", "SHA-256 mismatch");
  return "SHA-256 create, immediate verify, explicit-directory verify, and tamper rejection pass.";
}

async function testCollector() {
  const bundleRoot = join(temporaryDirectory, "target");
  const outputDirectory = join(temporaryDirectory, "target-release-output");
  assertTemporaryPath(bundleRoot);
  assertTemporaryPath(outputDirectory);
  const nsisDirectory = join(bundleRoot, "x86_64-pc-windows-msvc", "release", "bundle", "nsis");
  await mkdir(nsisDirectory, { recursive: true });
  await writeFile(join(nsisDirectory, "pude_1.0.0_x64-setup.exe"), "fake NSIS package");
  await writeFile(join(nsisDirectory, "pude_1.0.0_x64-setup.exe.sig"), "fake NSIS signature");

  const collector = join(root, "scripts/collect-release-bundle.mjs");
  const safeResult = run(process.execPath, [collector, "windows", outputDirectory, "--bundle-root", bundleRoot]);
  expectSuccess(safeResult, "isolated collector sibling-prefix fixture");
  for (const name of ["pude-windows-x64-setup.exe", "pude-windows-x64-setup.exe.sig", "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.md"]) {
    assert.ok((await stat(join(outputDirectory, name))).size > 0, `collector did not output ${name}`);
  }
  for (const invalidOutput of [bundleRoot, join(bundleRoot, "nested-output"), temporaryDirectory]) {
    assertTemporaryPath(invalidOutput);
    const result = run(process.execPath, [collector, "windows", invalidOutput, "--bundle-root", bundleRoot]);
    expectFailure(result, `overlapping collector path ${invalidOutput}`, "must be separate trees");
  }

  const noMatch = join(temporaryDirectory, "empty-target");
  const noMatchOutput = join(temporaryDirectory, "empty-output");
  await mkdir(noMatch, { recursive: true });
  assertTemporaryPath(noMatch);
  expectFailure(run(process.execPath, [collector, "macos", noMatchOutput, "--bundle-root", noMatch]), "empty macOS collector fixture", "found 0");
  return "Collector reads only an explicit temp Cargo target, copies all three legal sidecars, accepts sibling-prefix output, and rejects equal/nested/ancestor paths.";
}

async function testUpdateManifest() {
  const releaseDirectory = join(temporaryDirectory, "update-manifest");
  assertTemporaryPath(releaseDirectory);
  await mkdir(releaseDirectory, { recursive: true });
  const notesFile = join(releaseDirectory, "notes.md");
  await writeFile(notesFile, "- Added things\n");
  const writer = join(root, "scripts/write-update-manifest.mjs");

  expectFailure(run(process.execPath, [writer, releaseDirectory, "v1.2.3", notesFile]), "manifest without signatures", "no update package signatures");
  await writeFile(join(releaseDirectory, "pude-macos-arm64.app.tar.gz.sig"), "mac signature\n");
  await writeFile(join(releaseDirectory, "pude-windows-x64-setup.exe.sig"), "windows signature\n");
  expectSuccess(run(process.execPath, [writer, releaseDirectory, "v1.2.3", notesFile]), "update manifest");
  const manifest = JSON.parse(await readFile(join(releaseDirectory, "latest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.notes, "- Added things");
  assert.deepEqual(manifest.platforms["darwin-aarch64"], {
    signature: "mac signature",
    url: "https://github.com/MajajaX/pude/releases/download/v1.2.3/pude-macos-arm64.app.tar.gz",
  });
  assert.deepEqual(manifest.platforms["windows-x86_64"], {
    signature: "windows signature",
    url: "https://github.com/MajajaX/pude/releases/download/v1.2.3/pude-windows-x64-setup.exe",
  });
  expectFailure(run(process.execPath, [writer, releaseDirectory, "v1.2.3", notesFile]), "overwriting an existing manifest", "EEXIST");
  expectFailure(run(process.execPath, [writer, releaseDirectory, "1.2.3", notesFile]), "tag without v prefix", "usage");
  for (const invalidTag of ["v1.2.3garbage", "v01.2.3", "v1.2", "v1.2.3-01"]) {
    expectFailure(run(process.execPath, [writer, releaseDirectory, invalidTag, notesFile]), `malformed tag ${invalidTag}`, "usage");
  }
  expectFailure(run(process.execPath, [writer, releaseDirectory, "v1.2.3-rc.1", notesFile]), "prerelease tag", "stable releases only");
  const buildDirectory = join(temporaryDirectory, "update-manifest-build");
  assertTemporaryPath(buildDirectory);
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(join(buildDirectory, "pude-macos-arm64.app.tar.gz.sig"), "mac signature\n");
  expectSuccess(run(process.execPath, [writer, buildDirectory, "v1.2.3+build.4", notesFile]), "stable tag with build metadata");
  assert.equal(JSON.parse(await readFile(join(buildDirectory, "latest.json"), "utf8")).version, "1.2.3+build.4");
  return "Update manifest lists each platform's package URL and signature, covers partial releases, accepts only complete stable versions, and refuses empty input or overwrites.";
}

function validRelease(tag) {
  const assets = [
    "pude-windows-x64-setup.exe",
    "pude-windows-x64-setup.exe.sig",
    "pude-macos-arm64.dmg",
    "pude-macos-arm64.app.tar.gz",
    "pude-macos-arm64.app.tar.gz.sig",
    "latest.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES.md",
    "SHA256SUMS.txt",
  ].map((name, index) => ({
    id: index + 100,
    name,
    size: 10 + index,
    url: `https://api.github.com/repos/MajajaX/pude/releases/assets/${index + 100}`,
    browser_download_url: `https://github.com/MajajaX/pude/releases/download/${encodeURIComponent(tag)}/${name}`,
  }));
  return {
    id: 42,
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/MajajaX/pude/releases/tag/${encodeURIComponent(tag)}`,
    url: "https://api.github.com/repos/MajajaX/pude/releases/42",
    assets_url: "https://api.github.com/repos/MajajaX/pude/releases/42/assets",
    assets,
  };
}

async function testPublishedReleaseVerifier() {
  if (process.platform === "win32") {
    skippedTests.push("Fake `gh` executable tests require a Unix executable script.");
    return null;
  }
  const bin = join(temporaryDirectory, "fake-gh-bin");
  assertTemporaryPath(bin);
  await mkdir(bin, { recursive: true });
  const fakeGh = join(bin, "gh");
  await writeExecutable(fakeGh, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const endpoint = process.argv[3];
const response = endpoint === "repos/MajajaX/pude" ? process.env.FAKE_GH_REPO_RESPONSE : process.env.FAKE_GH_RESPONSE;
process.stdout.write(readFileSync(response, "utf8"));
`);
  const verifier = join(root, "scripts/verify-published-release.mjs");
  const responseFile = join(temporaryDirectory, "fake-release.json");
  const repositoryResponseFile = join(temporaryDirectory, "fake-repository.json");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_RESPONSE: responseFile,
    FAKE_GH_REPO_RESPONSE: repositoryResponseFile,
  };
  await writeFile(repositoryResponseFile, JSON.stringify({ full_name: "MajajaX/pude", private: false, visibility: "public" }));

  const stable = validRelease("v1.0.0");
  await writeFile(responseFile, JSON.stringify(stable));
  expectSuccess(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest"], { env }), "latest release URL verification");
  expectSuccess(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/tag/v1.0.0"], { env }), "tag release URL verification");

  const windowsOnly = validRelease("v1.0.0");
  windowsOnly.assets = windowsOnly.assets.filter((asset) => !asset.name.startsWith("pude-macos-arm64"));
  await writeFile(responseFile, JSON.stringify(windowsOnly));
  expectSuccess(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest", "--platform", "windows"], { env }), "Windows-only release URL verification");
  expectFailure(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest"], { env }), "cross-platform release still requires macOS", "pude-macos-arm64.dmg");

  const buildTag = "v1.2.3+ci.4";
  await writeFile(responseFile, JSON.stringify(validRelease(buildTag)));
  expectSuccess(run(process.execPath, [verifier, `https://github.com/MajajaX/pude/releases/tag/${buildTag}`], { env }), "canonical prerelease/build URL verification");

  const prereleaseTag = "v1.2.3-rc.1+ci.4";
  await writeFile(responseFile, JSON.stringify(validRelease(prereleaseTag)));
  expectFailure(
    run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/tag/" + prereleaseTag], { env }),
    "stable API metadata with a prerelease tag",
    "not a published release",
  );
  await writeFile(responseFile, JSON.stringify(validRelease("v1.0.0")));

  for (const invalidUrl of [
    "https://github.com/MajajaX/pude/releases/latest/",
    "https://user@github.com/MajajaX/pude/releases/latest",
    "https://github.com:443/MajajaX/pude/releases/latest",
    "https://github.com/MajajaX/pude/releases/latest?download=1",
    "https://github.com/MajajaX/pude/releases/latest#release",
    "https://github.com/MajajaX/pude/releases/tag/v01.0.0",
    "https://github.com/MajajaX/pude/releases/tag/v1.0.0-01",
    "https://github.com/MajajaX/pude/releases/tag/v1.2.3-rc.1%2Bci.4",
  ]) {
    expectFailure(run(process.execPath, [verifier, invalidUrl], { env }), `invalid release URL ${invalidUrl}`, "release URL must exactly match");
  }

  const foreign = validRelease("v1.0.0");
  foreign.url = "https://api.github.com/repos/attacker/other/releases/42";
  await writeFile(responseFile, JSON.stringify(foreign));
  expectFailure(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest"], { env }), "foreign API release", "not a published release from MajajaX/pude");

  await writeFile(repositoryResponseFile, JSON.stringify({ full_name: "MajajaX/pude", private: true, visibility: "private" }));
  await writeFile(responseFile, JSON.stringify(validRelease("v1.0.0")));
  expectFailure(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest"], { env }), "private repository release", "public MajajaX/pude repository");
  await writeFile(repositoryResponseFile, JSON.stringify({ full_name: "MajajaX/pude", private: false, visibility: "public" }));

  const missing = validRelease("v1.0.0");
  missing.assets = missing.assets.filter((asset) => asset.name !== "THIRD_PARTY_LICENSES.md");
  await writeFile(responseFile, JSON.stringify(missing));
  expectFailure(run(process.execPath, [verifier, "https://github.com/MajajaX/pude/releases/latest"], { env }), "missing release legal asset", "THIRD_PARTY_LICENSES.md");
  return "Fake GitHub API accepts stable canonical latest/tag/build-metadata releases and rejects prerelease tags, private or foreign repositories, malformed routes, and missing legal assets.";
}

async function testNoticeGate() {
  const fixture = join(temporaryDirectory, "notice-gate");
  const fixtureScripts = join(fixture, "scripts");
  assertTemporaryPath(fixture);
  await mkdir(fixtureScripts, { recursive: true });
  const checker = join(fixtureScripts, "verify-release-notices.mjs");
  await copyFile(join(root, "scripts/verify-release-notices.mjs"), checker);

  async function writeLegalRecords(notices, licenses) {
    await writeFile(join(fixture, "THIRD_PARTY_NOTICES.md"), notices);
    await writeFile(join(fixture, "THIRD_PARTY_LICENSES.md"), licenses);
  }

  await writeLegalRecords(
    "<!-- release-readiness: approved -->\n歷史紀錄中的待補／需核對文字不代表目前有未簽核項目。\n",
    "<!-- release-readiness: approved -->\n原始授權文字包含 TODO 範例，不是目前的簽核狀態。\n",
  );
  expectSuccess(run(process.execPath, [checker], { cwd: fixture }), "approved notice markers with historical placeholder wording");

  await writeLegalRecords("No signoff yet.\n", "<!-- release-readiness: approved -->\nLicense inventory.\n");
  expectFailure(run(process.execPath, [checker], { cwd: fixture }), "missing notice marker", "found 0");

  await writeLegalRecords("<!-- release-readiness: blocked -->\n", "<!-- release-readiness: approved -->\n");
  expectFailure(run(process.execPath, [checker], { cwd: fixture }), "blocked notice marker", "must be exactly");

  await writeLegalRecords(
    "<!-- release-readiness: approved -->\n<!-- release-readiness: blocked -->\n",
    "<!-- release-readiness: approved -->\n",
  );
  expectFailure(run(process.execPath, [checker], { cwd: fixture }), "duplicate notice marker", "found 2");
  return "Release notice gate accepts one approved marker despite historical placeholder wording and rejects missing, blocked, or duplicate markers.";
}

async function testVersionTool() {
  const fixture = join(temporaryDirectory, "version-checkout");
  assertTemporaryPath(fixture);
  for (const directory of ["scripts", "apps/desktop", "apps/web", "apps/desktop/src-tauri"]) {
    await mkdir(join(fixture, directory), { recursive: true });
  }
  for (const path of [
    "scripts/release-version.mjs",
    "scripts/semver.mjs",
    "scripts/verify-release-notices.mjs",
    "package.json",
    "package-lock.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.lock",
    "apps/desktop/src-tauri/tauri.conf.json",
    "LICENSE",
  ]) {
    const destination = join(fixture, path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(join(root, path), destination);
  }
  const cargoManifestPath = join(fixture, "apps/desktop/src-tauri/Cargo.toml");
  const cargoLockPath = join(fixture, "apps/desktop/src-tauri/Cargo.lock");
  for (const path of [cargoManifestPath, cargoLockPath]) {
    const crlf = (await readFile(path, "utf8")).replace(/\r?\n/g, "\r\n");
    await writeFile(path, crlf);
  }
  await writeFile(join(fixture, "THIRD_PARTY_NOTICES.md"), "<!-- release-readiness: approved -->\nVerified fixture notices.\n");
  await writeFile(join(fixture, "THIRD_PARTY_LICENSES.md"), "<!-- release-readiness: approved -->\nVerified fixture license texts.\n");
  const versionTool = join(fixture, "scripts/release-version.mjs");
  const initialVersion = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")).version;

  expectSuccess(run(process.execPath, [versionTool, "check", initialVersion]), "initial version check");
  for (const path of [cargoManifestPath, cargoLockPath]) {
    const crlf = await readFile(path, "utf8");
    assert.ok(crlf.includes("\r\n"), path + " was not converted to CRLF");
    assert.equal(crlf.replace(/\r\n/g, "").includes("\n"), false, path + " still contains bare LF line endings");
  }
  expectSuccess(run(process.execPath, [versionTool, "sync", "1.2.3-rc.1+build.4"]), "version sync");
  for (const path of [cargoManifestPath, cargoLockPath]) {
    const crlf = await readFile(path, "utf8");
    assert.ok(crlf.includes("\r\n"), path + " lost CRLF during version sync");
    assert.equal(crlf.replace(/\r\n/g, "").includes("\n"), false, path + " acquired bare LF line endings");
  }
  expectSuccess(run(process.execPath, [versionTool, "check", "1.2.3-rc.1+build.4"]), "synced version check");
  expectSuccess(run(process.execPath, [versionTool, "sync", "1.2.3-rc.1+build.4"]), "idempotent version sync");
  expectFailure(run(process.execPath, [versionTool, "sync", "1.2.3-01"]), "invalid numeric prerelease identifier", "semantic version");
  expectFailure(run(process.execPath, [versionTool, "release-check", "v1.2.3-rc.1+build.4"]), "prerelease release check", "stable versions only");
  expectSuccess(run(process.execPath, [versionTool, "sync", "1.0.0"]), "stable version sync");

  expectSuccess(run("git", ["init", "-q"], { cwd: fixture }), "fixture git init");
  expectSuccess(run("git", ["add", "-A"], { cwd: fixture }), "fixture git add");
  expectSuccess(run("git", ["-c", "user.name=Release Self-Test", "-c", "user.email=selftest@example.invalid", "commit", "-qm", "fixture release commit"], { cwd: fixture }), "fixture git commit");
  expectSuccess(run("git", ["tag", "v1.0.0"], { cwd: fixture }), "fixture v1.0.0 tag");
  expectSuccess(run(process.execPath, [versionTool, "release-check", "v1.0.0"], { cwd: fixture }), "clean exact-tag release check");
  expectFailure(run(process.execPath, [versionTool, "release-check", "v0.1.0"], { cwd: fixture }), "tag that does not match the version", "must be v1.0.0");
  await writeFile(join(fixture, "dirty.txt"), "dirty");
  expectFailure(run(process.execPath, [versionTool, "release-check", "v1.0.0"], { cwd: fixture }), "dirty release checkout", "must be clean");
  return "Version tool checks the copied repo version, syncs prerelease/build metadata idempotently, rejects invalid semver, accepts a clean tag matching the version, and rejects mismatched tags or dirty source.";
}

const reports = [];
try {
  assertTemporaryRoot();
  if (!(await stat(join(root, "THIRD_PARTY_LICENSES.md")).catch(() => undefined))) {
    throw new Error("THIRD_PARTY_LICENSES.md is required before release-tool self-tests can run");
  }
  reports.push(await testRunner());
  reports.push(await testChecksums());
  reports.push(await testCollector());
  reports.push(await testUpdateManifest());
  reports.push(await testPublishedReleaseVerifier());
  reports.push(await testNoticeGate());
  reports.push(await testVersionTool());
  for (const report of reports.filter(Boolean)) console.log(`PASS ${report}`);
  for (const skippedTest of skippedTests) console.log(`SKIP ${skippedTest}`);
} catch (error) {
  console.error(`release tooling self-test failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  assertTemporaryRoot();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
