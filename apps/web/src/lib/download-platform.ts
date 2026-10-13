import type { InstallerPlatform } from "../release-info";

export type RecommendationMessage =
  | "choose"
  | "windowsRecommended"
  | "windowsConfirm"
  | "macosRecommended"
  | "macosConfirm"
  | "windowsUnsupported"
  | "macosUnsupported"
  | "unsupported";

export interface DownloadRecommendation {
  platform: InstallerPlatform | null;
  message: RecommendationMessage;
}

interface ClientHints {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  mobile?: boolean;
}

export interface DownloadNavigator {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: ClientHints & {
    getHighEntropyValues?: (hints: string[]) => Promise<ClientHints>;
  };
}

export const NO_RECOMMENDATION: DownloadRecommendation = { platform: null, message: "choose" };

export function recommendInstaller(browser: DownloadNavigator, hints: ClientHints = {}): DownloadRecommendation {
  const userAgent = browser.userAgent;
  const platform = hints.platform || browser.userAgentData?.platform || browser.platform || "";
  if (hints.mobile || browser.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Mac/i.test(platform) && (browser.maxTouchPoints ?? 0) > 1)) {
    return { platform: null, message: "unsupported" };
  }

  const version = hints.platformVersion?.match(/^(\d+)(?:\.\d+)*$/)?.[1];
  const majorVersion = version === undefined ? undefined : Number(version);
  const architecture = hints.architecture?.toLowerCase();
  const legacyWindowsVersion = userAgent.match(/Windows NT (\d+)(?:\.\d+)*/i)?.[1];
  if (/^Windows$/i.test(platform) || /Win/i.test(platform) || /Windows NT/i.test(userAgent)) {
    if ((majorVersion !== undefined && majorVersion < 13)
      || architecture === "arm" || hints.bitness === "32"
      || (majorVersion === undefined && legacyWindowsVersion !== undefined && Number(legacyWindowsVersion) < 10)) {
      return { platform: null, message: "windowsUnsupported" };
    }
    const confirmed = majorVersion !== undefined && majorVersion >= 13
      && architecture === "x86" && hints.bitness === "64";
    return { platform: "windows", message: confirmed ? "windowsRecommended" : "windowsConfirm" };
  }

  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent)) {
    if ((majorVersion !== undefined && majorVersion < 14) || architecture === "x86" || hints.bitness === "32") {
      return { platform: null, message: "macosUnsupported" };
    }
    const confirmed = majorVersion !== undefined && majorVersion >= 14
      && architecture === "arm" && hints.bitness === "64";
    return { platform: "macos", message: confirmed ? "macosRecommended" : "macosConfirm" };
  }

  if (/Linux|CrOS/i.test(`${platform} ${userAgent}`)) return { platform: null, message: "unsupported" };
  return NO_RECOMMENDATION;
}

export async function detectDownloadRecommendation(browser: DownloadNavigator): Promise<DownloadRecommendation> {
  let hints: ClientHints = {};
  try {
    hints = await browser.userAgentData?.getHighEntropyValues?.([
      "platformVersion", "architecture", "bitness",
    ]) ?? {};
  } catch {
    // A browser may decline detailed device information. Keep the OS fallback usable.
  }
  return recommendInstaller(browser, hints);
}
