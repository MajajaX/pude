import { describe, expect, it } from "vitest";
import * as desktopRelease from "./release-url";
import * as webRelease from "../../../web/src/release-info";
import { parseSemver } from "../../../../shared/release-validation";
import { publishedReleaseUrlCases, semverCases } from "../../../../shared/release-validation-cases";

describe("shared release URL contract", () => {
  it("applies the same URL fixtures in desktop and web", () => {
    for (const { value, valid } of publishedReleaseUrlCases) {
      const expected = valid ? value : undefined;
      expect(desktopRelease.getPublishedReleaseUrl(value)).toBe(expected);
      expect(webRelease.getPublishedReleaseUrl(value)).toBe(expected);
    }
  });

  it("uses the same SemVer fixtures for version and release-tag parsing", () => {
    for (const { value, valid } of semverCases) {
      expect(Boolean(parseSemver(value))).toBe(valid);
      const tagUrl = `https://github.com/MajajaX/pude/releases/tag/v${value}`;
      expect(Boolean(desktopRelease.getPublishedReleaseUrl(tagUrl))).toBe(valid);
      expect(Boolean(webRelease.getPublishedReleaseUrl(tagUrl))).toBe(valid);
    }
  });
});

describe("desktop release stage and update entry", () => {
  it("keeps desktop stage language and click-to-check policy", () => {
    expect(desktopRelease.getReleaseStage("0.1.0-rc.1")).toBe("Development preview");
    expect(desktopRelease.getReleaseStage("0.1.0")).toBe("Manual updates");
    expect(desktopRelease.getReleaseStage("1.0.0")).toBe("Manual updates");

    expect(desktopRelease.getAboutReleaseTarget("1.0.0", undefined)).toEqual({
      url: desktopRelease.LATEST_RELEASE_URL,
      action: "check",
    });
    expect(desktopRelease.getAboutReleaseTarget("1.0.0", "")).toEqual({
      url: desktopRelease.LATEST_RELEASE_URL,
      action: "check",
    });
    expect(desktopRelease.getAboutReleaseTarget("0.1.0", undefined)).toEqual({
      url: desktopRelease.LATEST_RELEASE_URL,
      action: "check",
    });
    expect(desktopRelease.getAboutReleaseTarget("0.1.0-rc.1", undefined)).toEqual({});
    expect(desktopRelease.getAboutReleaseTarget("1.0.0-rc.1", undefined)).toEqual({});
    expect(desktopRelease.getAboutReleaseTarget("1.0.0", "javascript:alert(1)")).toEqual({});
    expect(desktopRelease.getAboutReleaseTarget("1.0.0", " ")).toEqual({});
    expect(desktopRelease.getAboutReleaseTarget("1.0.0", "https://github.com/MajajaX/pude/releases/tag/v1.0.0")).toEqual({
      url: "https://github.com/MajajaX/pude/releases/tag/v1.0.0",
      action: "download",
    });
  });

  it("keeps web stage policy separate from desktop wording", () => {
    expect(webRelease.getReleaseStage("0.1.0-rc.1")).toBe("preview");
    expect(webRelease.getReleaseStage("1.0.0-rc.1")).toBe("preview");
    expect(webRelease.getReleaseStage("0.1.0")).toBe("candidate");
    expect(webRelease.getReleaseStage("0.1.0", "https://github.com/MajajaX/pude/releases/latest")).toBe("published");
    expect(webRelease.getReleaseStage("1.0.0")).toBe("candidate");
    expect(webRelease.getReleaseStage("1.0.0", "https://github.com/MajajaX/pude/releases/latest")).toBe("published");
    expect(webRelease.getReleaseStage("1.0.0", webRelease.getPublishedReleaseUrl("javascript:alert(1)"))).toBe("candidate");
  });
});
