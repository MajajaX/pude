import { describe, expect, it } from "vitest";
import * as webRelease from "../../../web/src/release-info";
import { parseSemver } from "../../../../shared/release-validation";
import { publishedReleaseUrlCases, semverCases } from "../../../../shared/release-validation-cases";

describe("shared release URL contract", () => {
  it("applies the shared URL fixtures in web", () => {
    for (const { value, valid } of publishedReleaseUrlCases) {
      const expected = valid ? value : undefined;
      expect(webRelease.getPublishedReleaseUrl(value)).toBe(expected);
    }
  });

  it("uses the same SemVer fixtures for version and release-tag parsing", () => {
    for (const { value, valid } of semverCases) {
      expect(Boolean(parseSemver(value))).toBe(valid);
      const tagUrl = `https://github.com/MajajaX/pude/releases/tag/v${value}`;
      expect(Boolean(webRelease.getPublishedReleaseUrl(tagUrl))).toBe(valid);
    }
  });
});

describe("web release stage and download links", () => {
  it("derives the web release stage", () => {
    expect(webRelease.getReleaseStage("0.1.0-rc.1")).toBe("preview");
    expect(webRelease.getReleaseStage("1.0.0-rc.1")).toBe("preview");
    expect(webRelease.getReleaseStage("0.1.0")).toBe("candidate");
    expect(webRelease.getReleaseStage("0.1.0", "https://github.com/MajajaX/pude/releases/latest")).toBe("published");
    expect(webRelease.getReleaseStage("1.0.0")).toBe("candidate");
    expect(webRelease.getReleaseStage("1.0.0", "https://github.com/MajajaX/pude/releases/latest")).toBe("published");
    expect(webRelease.getReleaseStage("1.0.0", webRelease.getPublishedReleaseUrl("javascript:alert(1)"))).toBe("candidate");
  });

  it("builds direct installer links for latest and tagged releases", () => {
    expect(webRelease.getAssetDownloadUrl("https://github.com/MajajaX/pude/releases/latest", "pude-macos-arm64.dmg"))
      .toBe("https://github.com/MajajaX/pude/releases/latest/download/pude-macos-arm64.dmg");
    expect(webRelease.getAssetDownloadUrl("https://github.com/MajajaX/pude/releases/tag/v0.1.0", "pude-macos-arm64.dmg"))
      .toBe("https://github.com/MajajaX/pude/releases/download/v0.1.0/pude-macos-arm64.dmg");
  });
});
