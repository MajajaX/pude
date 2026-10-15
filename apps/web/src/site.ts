export type Locale = "en" | "zh-Hant";
export type Page = "home" | "docs";

export const SITE_URL = "https://pude.dev";
export const LOCALES: Locale[] = ["en", "zh-Hant"];

export const PAGE_PATHS = {
  home: { en: "/", "zh-Hant": "/zh/" },
  docs: { en: "/docs", "zh-Hant": "/zh/docs" },
} as const;

export function localeHref(page: Page, locale: Locale): string {
  return PAGE_PATHS[page][locale];
}

export const HOME_COPY = {
  en: {
    eyebrow: "a lightweight code editor for humans",
    titleA: "Open. Review.",
    titleB: "Edit. Done.",
    sub: "AI wrote the code. Open pude to see what changed, read the diff, and make a few edits yourself. Load what you need and leave CPU and memory for the work already running.",
  },
  "zh-Hant": {
    eyebrow: "給人的輕量程式碼編輯器",
    titleA: "打開就看，",
    titleB: "改完就走。",
    sub: "AI 寫完，打開 pude 看看改了什麼。檢視 Git 差異、讀懂程式碼，再親手修幾行。按需載入，把 CPU 與記憶體留給正在跑的工作。",
  },
};

export const PAGE_META = {
  home: {
    en: {
      title: "pude — A Lightweight Code Editor for Humans",
      description: "A free, open-source desktop code editor for the AI coding era. Review Git changes and edit by hand. For Windows 11 x64 and macOS 14+ Apple Silicon.",
    },
    "zh-Hant": {
      title: "pude — 給人的輕量程式碼編輯器",
      description: "AI coding 時代，給人打開就看的輕量桌面程式碼編輯器。檢視 Git 差異、閱讀與手動修改，改完就走。免費開源，支援 Windows 11 x64 與 macOS 14 以上 Apple Silicon。",
    },
  },
  docs: {
    en: {
      title: "pude Docs — Installation, Git, Shortcuts & Plugins",
      description: "Install pude on Windows or macOS, review Git changes, edit files, use terminals and keyboard shortcuts, and develop local plugins.",
    },
    "zh-Hant": {
      title: "pude 使用文件 — 安裝、Git、快捷鍵與外掛開發",
      description: "pude 輕量程式碼編輯器使用指南：Windows 與 macOS 安裝、Git 變更檢視、檔案編輯、終端機、鍵盤快捷鍵與本地外掛開發。",
    },
  },
};
