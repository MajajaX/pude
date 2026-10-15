import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const [platform, artifactArgument] = process.argv.slice(2);
if (!new Set(["windows", "macos"]).has(platform) || !artifactArgument) {
  throw new Error("usage: verify-release-artifact.mjs <windows|macos> <installer-or-dmg>");
}

const artifact = resolve(artifactArgument);

function run(command, args, { env = process.env, label = command, timeoutMs = 120_000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output) process.stdout.write(output);
  if (result.error || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT" ? ` after ${timeoutMs} ms` : result.status === null ? " to start" : ` with exit code ${result.status}`;
    throw new Error(`${label} failed${detail}`);
  }
  return output;
}

if (platform === "windows") {
  if (process.platform !== "win32") throw new Error("Windows signature verification must run on Windows");
  const expectedThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replaceAll(" ", "").toUpperCase();
  if (!expectedThumbprint) throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT is required");
  if (basename(artifact) !== "pude-windows-x64-setup.exe") throw new Error("unexpected Windows installer filename");
  const { version } = JSON.parse(await readFile(fileURLToPath(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8"));
  const expectedVersion = new RegExp(`^${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.0)?(?:\\+.*)?$`);
  const signature = run("pwsh", [
    "-NoProfile",
    "-File",
    fileURLToPath(new URL("./verify-windows-signature.ps1", import.meta.url)),
    artifact,
    expectedThumbprint,
    version,
    resolve(artifact, "..", "LICENSE"),
    resolve(artifact, "..", "THIRD_PARTY_NOTICES.md"),
    resolve(artifact, "..", "THIRD_PARTY_LICENSES.md"),
  ], { label: "Windows installer and installed payload verification", timeoutMs: 600_000 });
  const jsonLine = signature.trim().split(/\r?\n/).at(-1);
  const result = JSON.parse(jsonLine);
  if (
    result.Status !== "Valid" ||
    result.Thumbprint?.replaceAll(" ", "").toUpperCase() !== expectedThumbprint ||
    !expectedVersion.test(result.ProductVersion) ||
    result.Machine !== "x64" ||
    result.AppStatus !== "Valid" ||
    result.AppThumbprint?.replaceAll(" ", "").toUpperCase() !== expectedThumbprint ||
    !expectedVersion.test(result.AppProductVersion)
  ) {
    throw new Error("the NSIS installer is not validly signed by the imported release certificate");
  }
  console.log("Windows NSIS installer and installed x64 app signature, version, and notices are valid.");
} else {
  if (process.platform !== "darwin") throw new Error("macOS notarization verification must run on macOS");
  if (basename(artifact) !== "pude-macos-arm64.dmg") throw new Error("unexpected macOS disk image filename");
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!teamId || !signingIdentity?.startsWith("Developer ID Application:")) {
    throw new Error("a Developer ID signing identity and APPLE_TEAM_ID are required");
  }

  const mountPoint = await mkdtemp(join(tmpdir(), "pude-release-dmg-"));
  let mounted = false;
  try {
    run("xcrun", ["stapler", "validate", artifact], { label: "DMG notarization ticket validation", timeoutMs: 180_000 });
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", artifact], {
      label: "Gatekeeper disk image assessment",
      timeoutMs: 180_000,
    });
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, artifact], {
      label: "mount signed DMG",
      timeoutMs: 120_000,
    });
    mounted = true;
    const appNames = (await readdir(mountPoint)).filter((name) => name.endsWith(".app"));
    if (appNames.length !== 1) throw new Error(`expected one app bundle in the DMG, found ${appNames.length}`);
    const app = join(mountPoint, appNames[0]);
    const appResources = join(app, "Contents/Resources");
    for (const legalFile of ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.md"]) {
      run("/usr/bin/cmp", ["-s", join(appResources, legalFile), fileURLToPath(new URL(`../${legalFile}`, import.meta.url))], {
        label: `verify bundled ${legalFile}`,
      });
    }
    const infoPlist = join(app, "Contents/Info.plist");
    const bundleVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPlist], {
      label: "read app version",
    }).trim();
    const bundleId = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist], {
      label: "read app bundle identifier",
    }).trim();
    const minimumSystemVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :LSMinimumSystemVersion", infoPlist], {
      label: "read minimum macOS version",
    }).trim();
    const tauriConfig = JSON.parse(await readFile(fileURLToPath(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8"));
    if (bundleVersion !== tauriConfig.version || bundleId !== tauriConfig.identifier || minimumSystemVersion !== tauriConfig.bundle.macOS.minimumSystemVersion) {
      throw new Error(`unexpected macOS bundle metadata: version=${bundleVersion}, id=${bundleId}, minimum=${minimumSystemVersion}`);
    }
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { label: "app code signature verification", timeoutMs: 180_000 });
    const signatureDetails = run("codesign", ["-dv", "--verbose=4", app], { label: "read app signing identity", timeoutMs: 60_000 });
    if (!signatureDetails.includes(`Authority=${signingIdentity}`) || !signatureDetails.includes(`TeamIdentifier=${teamId}`)) {
      throw new Error("the app bundle is not signed by the expected Developer ID team");
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", app], { label: "Gatekeeper app assessment", timeoutMs: 180_000 });
    const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist], {
      label: "read app executable name",
    }).trim();
    const architectures = run("lipo", ["-archs", join(app, "Contents/MacOS", executable)], {
      label: "read app executable architectures",
    }).trim();
    if (architectures !== "arm64") throw new Error(`expected an arm64-only app executable, found ${architectures}`);
    console.log("macOS DMG is stapled, Gatekeeper accepted, and contains a Developer ID signed arm64 app.");
  } finally {
    if (mounted) {
      const detach = spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      if (detach.error || detach.status !== 0) {
        throw new Error(`could not detach the verification mount${detach.error?.code === "ETIMEDOUT" ? " within 30 seconds" : `: ${detach.stderr ?? "unknown error"}`}; leaving the mount point intact`);
      }
      mounted = false;
    }
    await rmdir(mountPoint);
  }
}
