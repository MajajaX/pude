import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDownloadRecommendation, recommendInstaller } from "../src/lib/download-platform.ts";

const windows = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" };
const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" };

test("Windows 11 and newer x64 PCs receive the Windows installer", () => {
  for (const platformVersion of ["13.0.0", "19.0.0"]) {
    assert.deepEqual(recommendInstaller(windows, { platform: "Windows", platformVersion, architecture: "x86", bitness: "64" }), {
      platform: "windows", message: "windowsRecommended",
    });
  }
});

test("Windows 10, older Windows, ARM and 32-bit systems are not recommended", () => {
  for (const hints of [
    { platformVersion: "10.0.0", architecture: "x86", bitness: "64" },
    { platformVersion: "0.0.0", architecture: "x86", bitness: "64" },
    { platformVersion: "13.0.0", architecture: "arm", bitness: "64" },
    { platformVersion: "13.0.0", architecture: "x86", bitness: "32" },
  ]) {
    assert.deepEqual(recommendInstaller(windows, hints), { platform: null, message: "windowsUnsupported" });
  }
  assert.deepEqual(recommendInstaller({ userAgent: "Mozilla/5.0 (Windows NT 6.1; Win64; x64)" }), {
    platform: null, message: "windowsUnsupported",
  });
});

test("Windows user-agent strings never claim to distinguish Windows 10 from 11", () => {
  assert.deepEqual(recommendInstaller(windows), { platform: "windows", message: "windowsConfirm" });
  assert.deepEqual(recommendInstaller(windows, { platformVersion: "not-a-version", architecture: "x86", bitness: "64" }), {
    platform: "windows", message: "windowsConfirm",
  });
});

test("Apple Silicon on supported macOS is recommended despite a frozen Intel user agent", () => {
  assert.deepEqual(recommendInstaller(mac, { platform: "macOS", platformVersion: "14.6.0", architecture: "arm", bitness: "64" }), {
    platform: "macos", message: "macosRecommended",
  });
});

test("Intel Macs and known macOS versions below 14 have no recommended native installer", () => {
  for (const hints of [
    { platformVersion: "15.0.0", architecture: "x86", bitness: "64" },
    { platformVersion: "13.6.0", architecture: "arm", bitness: "64" },
    { platformVersion: "15.0.0", architecture: "arm", bitness: "32" },
  ]) assert.deepEqual(recommendInstaller(mac, hints), { platform: null, message: "macosUnsupported" });
});

test("Safari and incomplete client hints ask users to confirm macOS and Apple Silicon", () => {
  assert.deepEqual(recommendInstaller(mac), { platform: "macos", message: "macosConfirm" });
  assert.deepEqual(recommendInstaller(mac, { architecture: "arm", bitness: "64" }), {
    platform: "macos", message: "macosConfirm",
  });
});

test("mobile devices, desktop-mode iPads, Linux and ChromeOS do not receive a desktop recommendation", () => {
  for (const browser of [
    { userAgent: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l" },
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
    { ...mac, maxTouchPoints: 5 },
    { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" },
    { userAgent: "Mozilla/5.0 (X11; CrOS x86_64)", platform: "Linux x86_64" },
    { ...windows, userAgentData: { platform: "Windows", mobile: true } },
  ]) assert.deepEqual(recommendInstaller(browser), { platform: null, message: "unsupported" });
});

test("an unknown device is asked to choose an installer", () => {
  assert.deepEqual(recommendInstaller({ userAgent: "" }), { platform: null, message: "choose" });
});

test("detailed hints are requested from the browser and refine the OS fallback", async () => {
  const recommendation = await detectDownloadRecommendation({
    ...windows,
    userAgentData: {
      platform: "Windows",
      async getHighEntropyValues(requested) {
        assert.deepEqual(requested, ["platformVersion", "architecture", "bitness"]);
        return { platformVersion: "13.0.0", architecture: "x86", bitness: "64" };
      },
    },
  });
  assert.deepEqual(recommendation, { platform: "windows", message: "windowsRecommended" });
});

test("unavailable or declined client hints keep OS selection usable", async () => {
  assert.deepEqual(await detectDownloadRecommendation(windows), { platform: "windows", message: "windowsConfirm" });
  assert.deepEqual(await detectDownloadRecommendation({
    ...mac,
    userAgentData: { platform: "macOS", getHighEntropyValues: async () => { throw new Error("denied"); } },
  }), { platform: "macos", message: "macosConfirm" });
});
