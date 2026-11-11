import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// The Windows installer is not Authenticode-signed, so only the macOS DMG has a
// platform signature to verify; both update packages are checked by verify-update-signatures.mjs.
const [platform, artifactArgument] = process.argv.slice(2);
if (platform !== "macos" || !artifactArgument) {
  throw new Error("usage: verify-release-artifact.mjs macos <dmg>");
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
    const detail =
      result.error?.code === "ETIMEDOUT"
        ? ` after ${timeoutMs} ms`
        : result.status === null
          ? " to start"
          : ` with exit code ${result.status}`;
    throw new Error(`${label} failed${detail}`);
  }
  return output;
}

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
    run(
      "/usr/bin/cmp",
      ["-s", join(appResources, legalFile), fileURLToPath(new URL(`../${legalFile}`, import.meta.url))],
      {
        label: `verify bundled ${legalFile}`,
      },
    );
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
  const tauriConfig = JSON.parse(
    await readFile(fileURLToPath(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
  );
  if (
    bundleVersion !== tauriConfig.version ||
    bundleId !== tauriConfig.identifier ||
    minimumSystemVersion !== tauriConfig.bundle.macOS.minimumSystemVersion
  ) {
    throw new Error(
      `unexpected macOS bundle metadata: version=${bundleVersion}, id=${bundleId}, minimum=${minimumSystemVersion}`,
    );
  }
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    label: "app code signature verification",
    timeoutMs: 180_000,
  });
  const signatureDetails = run("codesign", ["-dv", "--verbose=4", app], {
    label: "read app signing identity",
    timeoutMs: 60_000,
  });
  if (
    !signatureDetails.includes(`Authority=${signingIdentity}`) ||
    !signatureDetails.includes(`TeamIdentifier=${teamId}`)
  ) {
    throw new Error("the app bundle is not signed by the expected Developer ID team");
  }
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", app], {
    label: "Gatekeeper app assessment",
    timeoutMs: 180_000,
  });
  const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist], {
    label: "read app executable name",
  }).trim();
  const architectures = run("lipo", ["-archs", join(app, "Contents/MacOS", executable)], {
    label: "read app executable architectures",
  }).trim();
  if (architectures !== "arm64") throw new Error(`expected an arm64-only app executable, found ${architectures}`);
  console.log("macOS DMG is stapled, Gatekeeper accepted, and contains a Developer ID signed arm64 app.");
} finally {
  // Report a failed detach without hiding the error that ended the checks above.
  let detached = !mounted;
  if (mounted) {
    const detach = spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    detached = !detach.error && detach.status === 0;
    if (!detached) {
      console.error(
        `could not detach the verification mount${detach.error?.code === "ETIMEDOUT" ? " within 30 seconds" : `: ${detach.stderr ?? "unknown error"}`}; leaving the mount point intact`,
      );
      process.exitCode = 1;
    }
  }
  if (detached) await rmdir(mountPoint);
}
