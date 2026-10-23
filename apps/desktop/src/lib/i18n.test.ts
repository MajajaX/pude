import { describe, expect, it } from "vitest";
import { applyLanguage, locale, resolveLocale, t, translateMessage } from "./i18n";

describe("i18n", () => {
  it("follows the system language for auto", () => {
    expect(resolveLocale("auto", ["zh-TW", "en-US"])).toBe("zh-Hant");
    expect(resolveLocale("auto", ["zh-Hant-HK"])).toBe("zh-Hant");
    expect(resolveLocale("auto", ["zh-CN", "zh-TW"])).toBe("en");
    expect(resolveLocale("auto", ["fr-FR", "en-GB"])).toBe("en");
    expect(resolveLocale("zh-Hant", ["en-US"])).toBe("zh-Hant");
  });

  it("falls back to English and fills placeholders", async () => {
    await applyLanguage("en");
    expect(t("Open folder")).toBe("Open folder");
    expect(t("Opened {name}", { name: "pude" })).toBe("Opened pude");
  });

  it("translates interface text and native messages in Traditional Chinese", async () => {
    await applyLanguage("zh-Hant");
    expect(locale()).toBe("zh-Hant");
    expect(t("Open folder")).toBe("開啟資料夾");
    expect(t("Opened {name}", { name: "pude" })).toContain("pude");
    expect(translateMessage("Unable to save file. Permission denied (os error 13)")).toBe("無法儲存檔案。Permission denied (os error 13)");
    expect(translateMessage("Something only the OS says")).toBe("Something only the OS says");
    await applyLanguage("en");
  });
});
