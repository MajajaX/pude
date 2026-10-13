import { locale, localeHref, setLocale, switchLocaleFromLink, type Locale } from "./i18n-runtime";

export { locale, localeHref, setLocale, switchLocaleFromLink };
export type { Locale } from "./i18n-runtime";

export type FilmChapter = "open" | "edit" | "save" | "git" | "terminal" | "markdown";

const en = {
  nav: {
    sections: "Sections",
    showcase: "Tour",
    features: "Features",
    architecture: "Architecture",
    philosophy: "Philosophy",
    docs: "Docs",
    download: "Download",
  },
  hero: {
    eyebrow: "pure code editor · open source",
    titleA: "Code.",
    titleB: "Nothing else.",
    sub: "pude is a local-first desktop code editor built on Rust and Tauri. Open a folder, write, review Git, run a terminal — while the rest of your machine stays quiet.",
    ctaPrimary: "Get pude",
    ctaSecondary: "How it stays light",
    note: "Windows 11 x64 · macOS 14+ Apple Silicon. Linux builds are planned.",
    stack: ["Rust", "Tauri 2", "SolidJS", "CodeMirror 6", "MIT"],
  },
  film: {
    label: "Product film",
    ariaLabel: "Animated walkthrough of pude: open a folder, edit, save, review Git, run a terminal and preview Markdown.",
    play: "Play",
    pause: "Pause",
    openFolder: "Open folder",
    explorer: "Explorer",
    git: "Git",
    changes: "Changes",
    terminal: "Terminal",
    source: "Source",
    preview: "Preview",
    saved: "Saved",
    loading: "reading src/",
    chapters: [
      { k: "open", title: "Open", caption: "Only the top level is read. Folders load when you expand them." },
      { k: "edit", title: "Write", caption: "Syntax highlighting runs locally — no language server required." },
      { k: "save", title: "Save", caption: "Atomic saves keep your line endings and protect unsaved work." },
      { k: "git", title: "Review", caption: "Git status and side-by-side diffs from the Git already on your machine." },
      { k: "terminal", title: "Run", caption: "A real PTY starts the first time you open a terminal tab." },
      { k: "markdown", title: "Preview", caption: "Flip Markdown between source and a rendered preview." },
    ] as { k: FilmChapter; title: string; caption: string }[],
  },
  manifesto: {
    eyebrow: "Why pude",
    text: "Most editors grow into platforms. pude stays an editor. It reads the folder you open, loads what you look at, starts a terminal when you ask — and goes quiet the moment you stop typing.",
  },
  showcase: {
    eyebrow: "The tour",
    title: "Five screens. One calm workflow.",
    sub: "Captured from the current build. Keep scrolling to move through them.",
    steps: [
      {
        k: "editor",
        title: "Your code, front and center",
        desc: "A single focused editing surface with tabs, pinning, find and replace, and a file tree that only loads the folders you open.",
      },
      {
        k: "git",
        title: "Git, one tab away",
        desc: "Branch, staged, unstaged, untracked and conflicted files sit next to the Explorer — refreshed by events, never by polling.",
      },
      {
        k: "diff",
        title: "Review before you commit",
        desc: "Open any change as a side-by-side or stacked diff. Large diffs stay smooth with windowed rendering.",
      },
      {
        k: "terminal",
        title: "Terminals that wait for you",
        desc: "Add as many terminal tabs as you need. Each one starts its own PTY on first view and keeps running while the panel is hidden.",
      },
      {
        k: "markdown",
        title: "Markdown, rendered",
        desc: "Toggle any Markdown file between source and preview from the status bar. The text itself never changes.",
      },
    ],
  },
  features: {
    eyebrow: "Core",
    title: "A small core. Every feature earns its place.",
    sub: "Each capability has to justify its permanent cost in CPU, memory and attention. These made the cut.",
    items: [
      {
        k: "01",
        title: "Lazy by default",
        desc: "Opening a workspace reads only its top level. Folders load on expand; parsers and terminals load on first use.",
        meta: "list_dir(\"src/\") · on expand",
      },
      {
        k: "02",
        title: "Local-first",
        desc: "No account, no cloud sync. Files stay at their local paths; the network is used only by Git remotes, your terminal or plugins you approve.",
        meta: "~/projects/pude-demo",
      },
      {
        k: "03",
        title: "Git, built in",
        desc: "Branches, staging, commit graph, stash and diffs — powered by the Git CLI you already have.",
        meta: "git status --porcelain=v2 -z",
      },
      {
        k: "04",
        title: "Real terminals",
        desc: "Multiple tabs, each a real PTY started on first view. Closing a tab reclaims its whole process tree.",
        meta: "pty · 5,000 lines scrollback",
      },
      {
        k: "05",
        title: "Saves you can trust",
        desc: "Atomic writes, external-change prompts, recovery checkpoints and preserved LF/CRLF line endings. Unsaved work is never silently overwritten.",
        meta: "UTF-8 · LF / CRLF preserved",
      },
      {
        k: "06",
        title: "Permissioned plugins",
        desc: "Plugins run in sandboxed workers with scoped permissions you can review and revoke.",
        meta: "editor.read · git.read · network",
      },
    ],
  },
  architecture: {
    eyebrow: "Architecture",
    title: "How it stays light.",
    sub: "A thin interface over a Rust core. Slow work happens off the UI thread, and nothing runs until you need it.",
    layers: [
      {
        name: "Interface",
        tech: "SolidJS · CodeMirror 6 · xterm.js",
        detail: "Fine-grained updates and virtualized lists render only what is on screen.",
      },
      {
        name: "Bridge",
        tech: "Typed Tauri IPC",
        detail: "Whole operations in one round trip — no per-row chatter.",
      },
      {
        name: "Core",
        tech: "Rust · filesystem · Git · watcher · PTY · plugins · LSP",
        detail: "Bounded queues and cancellation keep slow I/O away from typing.",
      },
      {
        name: "Your machine",
        tech: "Local folders · system Git · your shell",
        detail: "Files stay where they are. pude bundles no shell and no language server.",
      },
    ],
    principles: [
      { title: "Event-driven", desc: "File and Git updates are debounced and merged. No polling loop keeps the screen fresh." },
      { title: "Bounded", desc: "Queues, output buffers and caches have limits, so a noisy process can't drag the editor down." },
      { title: "Cancelable", desc: "Switching workspaces cancels stale work. Old results never overwrite new state." },
    ],
  },
  languages: {
    eyebrow: "Syntax",
    title: "Highlighting for the languages you use, parsed on your machine.",
  },
  philosophy: {
    eyebrow: "Philosophy",
    title: "Not an IDE — on purpose.",
    sub: "pude draws a hard line around its core so it stays fast, quiet and maintainable for years.",
    wontTitle: "Left out of the core",
    wont: [
      "Indexing your whole repository",
      "A debugger or build system",
      "AI services and cloud sync",
      "A plugin marketplace",
      "Language servers that never sleep",
    ],
    willTitle: "Always part of pude",
    will: [
      "Start fast and stay quiet",
      "Protect your unsaved work",
      "Show Git state truthfully",
      "Work without an account",
      "Leave your CPU and memory to you",
    ],
  },
  shortcuts: {
    eyebrow: "Keyboard-first",
    title: "Your hands never leave the keys.",
    sub: "A small, memorable set covers the whole daily flow. On Windows, use Ctrl in place of ⌘ — Replace is Ctrl H.",
    items: [
      { keys: ["⌘", "S"], label: "Save" },
      { keys: ["⌘", "⇧", "S"], label: "Save as" },
      { keys: ["⌘", "O"], label: "Open file" },
      { keys: ["⌘", "K", "⌘", "O"], label: "Open folder" },
      { keys: ["⌘", "F"], label: "Find" },
      { keys: ["⌘", "⌥", "F"], label: "Replace" },
      { keys: ["⌘", "G"], label: "Go to line" },
      { keys: ["⌘", "W"], label: "Close tab" },
      { keys: ["⌃", "⇥"], label: "Next tab" },
      { keys: ["⌘", "`"], label: "Terminal" },
      { keys: ["⌘", "⇧", "P"], label: "Commands" },
    ],
  },
  cta: {
    title: "Pure code. Pure focus.",
    sub: "Free and open source under the MIT License. Downloads open here once a verified release is published.",
    button: "Open release and download",
    note: "Download targets: Windows 11 x64 and macOS 14+ Apple Silicon arm64. Linux releases are planned.",
    unavailable: "Release downloads are not configured yet.",
    versionLabel: "Version",
    stages: {
      preview: "Development preview",
      candidate: "Release candidate",
      published: "Published release",
    },
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "Built with Tauri, SolidJS, CodeMirror 6 and Rust. MIT licensed.",
  },
};

export type Dict = typeof en;

const zhHant: Dict = {
  nav: {
    sections: "頁面段落",
    showcase: "功能導覽",
    features: "核心特色",
    architecture: "架構",
    philosophy: "設計理念",
    docs: "文件",
    download: "下載",
  },
  hero: {
    eyebrow: "pure code editor · 開放原始碼",
    titleA: "寫程式，",
    titleB: "僅此而已。",
    sub: "pude 是以 Rust 與 Tauri 打造的本地優先桌面程式碼編輯器。打開資料夾、寫程式、檢視 Git、執行終端機——其餘時間，讓你的電腦保持安靜。",
    ctaPrimary: "取得 pude",
    ctaSecondary: "它如何保持輕量",
    note: "Windows 11 x64 · macOS 14+ Apple Silicon。Linux 版本規劃中。",
    stack: ["Rust", "Tauri 2", "SolidJS", "CodeMirror 6", "MIT"],
  },
  film: {
    label: "產品影片",
    ariaLabel: "pude 動態導覽：開啟資料夾、編輯、儲存、檢視 Git、執行終端機與預覽 Markdown。",
    play: "播放",
    pause: "暫停",
    openFolder: "開啟資料夾",
    explorer: "檔案",
    git: "Git",
    changes: "變更",
    terminal: "終端機",
    source: "原始碼",
    preview: "預覽",
    saved: "已儲存",
    loading: "讀取 src/",
    chapters: [
      { k: "open", title: "開啟", caption: "只讀取最上層；展開資料夾時才載入內容。" },
      { k: "edit", title: "撰寫", caption: "語法突顯在本機執行，不需要語言伺服器。" },
      { k: "save", title: "儲存", caption: "原子化寫入，保留換行格式，保護未儲存的內容。" },
      { k: "git", title: "檢視", caption: "直接使用你電腦上的 Git，呈現狀態與並排差異。" },
      { k: "terminal", title: "執行", caption: "第一次開啟終端機分頁時，才啟動真正的 PTY。" },
      { k: "markdown", title: "預覽", caption: "Markdown 可在原始碼與渲染預覽之間切換。" },
    ],
  },
  manifesto: {
    eyebrow: "為什麼是 pude",
    text: "多數編輯器最後都長成了平台，pude 選擇只當一個編輯器。它只讀你打開的資料夾，只載入你正在看的內容，在你需要時才啟動終端機——當你停下手，它也跟著安靜下來。",
  },
  showcase: {
    eyebrow: "功能導覽",
    title: "五個畫面，一條安靜的工作流程。",
    sub: "畫面擷取自目前的版本。繼續往下捲動，逐一瀏覽。",
    steps: [
      {
        k: "editor",
        title: "程式碼永遠是主角",
        desc: "專注的單一編輯區，支援分頁、釘選、尋找與取代；檔案樹只在你展開時載入資料夾。",
      },
      {
        k: "git",
        title: "Git 就在隔壁分頁",
        desc: "分支、已暫存、未暫存、未追蹤與衝突檔案都在檔案總管旁；由事件觸發更新，從不輪詢。",
      },
      {
        k: "diff",
        title: "提交前先看清楚",
        desc: "任何變更都能以並排或堆疊方式檢視差異。視窗化渲染讓大型差異依然流暢。",
      },
      {
        k: "terminal",
        title: "等你開口的終端機",
        desc: "需要幾個終端機分頁就開幾個。每個分頁首次顯示時才啟動自己的 PTY，面板隱藏時仍持續執行。",
      },
      {
        k: "markdown",
        title: "Markdown，即時渲染",
        desc: "從狀態列切換原始碼與預覽，檔案文字本身不會被更動。",
      },
    ],
  },
  features: {
    eyebrow: "核心特色",
    title: "核心很小，每項功能都得證明自己。",
    sub: "每項能力都必須證明它值得長期佔用的 CPU、記憶體與注意力。以下是留下來的。",
    items: [
      {
        k: "01",
        title: "預設延遲載入",
        desc: "開啟工作區只讀取最上層；展開時才載入資料夾，第一次使用時才載入解析器與終端機。",
        meta: "list_dir(\"src/\") · on expand",
      },
      {
        k: "02",
        title: "本地優先",
        desc: "不需要帳號，也沒有雲端同步。檔案留在原本的路徑；只有 Git 遠端、終端機與你核准的外掛會連網。",
        meta: "~/projects/pude-demo",
      },
      {
        k: "03",
        title: "內建 Git",
        desc: "分支、暫存、提交圖譜、stash 與差異比對——直接使用你已安裝的 Git CLI。",
        meta: "git status --porcelain=v2 -z",
      },
      {
        k: "04",
        title: "真正的終端機",
        desc: "多個分頁，每個都是首次顯示時啟動的真實 PTY；關閉分頁會回收整個程序樹。",
        meta: "pty · 5,000 行 scrollback",
      },
      {
        k: "05",
        title: "值得信任的儲存",
        desc: "原子化寫入、外部變更提示、復原檢查點，並保留 LF／CRLF 換行。未儲存的內容絕不會被默默覆寫。",
        meta: "UTF-8 · 保留 LF / CRLF",
      },
      {
        k: "06",
        title: "權限把關的外掛",
        desc: "外掛在沙箱 Worker 中執行，只取得你可檢視、可撤銷的範圍權限。",
        meta: "editor.read · git.read · network",
      },
    ],
  },
  architecture: {
    eyebrow: "架構",
    title: "它如何保持輕量。",
    sub: "輕薄的介面，加上 Rust 核心。耗時工作不佔用 UI 執行緒，你不需要的東西一律不執行。",
    layers: [
      {
        name: "介面",
        tech: "SolidJS · CodeMirror 6 · xterm.js",
        detail: "細粒度更新與虛擬化列表，只渲染畫面上看得到的內容。",
      },
      {
        name: "橋接層",
        tech: "型別化 Tauri IPC",
        detail: "一次往返完成整個操作，不逐列來回查詢。",
      },
      {
        name: "核心",
        tech: "Rust · 檔案系統 · Git · watcher · PTY · 外掛 · LSP",
        detail: "有界佇列與可取消的請求，讓慢速 I/O 不干擾打字。",
      },
      {
        name: "你的電腦",
        tech: "本機資料夾 · 系統 Git · 你的 shell",
        detail: "檔案留在原處。pude 不內附 shell，也不內附語言伺服器。",
      },
    ],
    principles: [
      { title: "事件驅動", desc: "檔案與 Git 更新會去抖動並合併，不靠輪詢維持畫面。" },
      { title: "有界", desc: "佇列、輸出緩衝與快取都有上限，吵雜的程序拖不垮編輯器。" },
      { title: "可取消", desc: "切換工作區會取消過時的工作，舊結果不會覆蓋新狀態。" },
    ],
  },
  languages: {
    eyebrow: "語法突顯",
    title: "你常用的語言都有突顯，全部在本機解析。",
  },
  philosophy: {
    eyebrow: "設計理念",
    title: "不是 IDE——這是刻意的。",
    sub: "pude 為核心劃下明確界線，讓它在未來多年依然快速、安靜、易於維護。",
    wontTitle: "核心刻意不做",
    wont: [
      "索引你的整個儲存庫",
      "除錯器或建置系統",
      "AI 服務與雲端同步",
      "外掛市集",
      "永不休息的語言伺服器",
    ],
    willTitle: "pude 始終堅持",
    will: [
      "快速啟動，安靜運行",
      "保護你未儲存的工作",
      "如實呈現 Git 狀態",
      "不需要帳號也能工作",
      "把 CPU 與記憶體留給你",
    ],
  },
  shortcuts: {
    eyebrow: "鍵盤優先",
    title: "雙手不必離開鍵盤。",
    sub: "一小組好記的快捷鍵，涵蓋每天的完整流程。Windows 請以 Ctrl 取代 ⌘，取代功能為 Ctrl H。",
    items: [
      { keys: ["⌘", "S"], label: "儲存" },
      { keys: ["⌘", "⇧", "S"], label: "另存新檔" },
      { keys: ["⌘", "O"], label: "開啟檔案" },
      { keys: ["⌘", "K", "⌘", "O"], label: "開啟資料夾" },
      { keys: ["⌘", "F"], label: "尋找" },
      { keys: ["⌘", "⌥", "F"], label: "取代" },
      { keys: ["⌘", "G"], label: "跳至行號" },
      { keys: ["⌘", "W"], label: "關閉分頁" },
      { keys: ["⌃", "⇥"], label: "下一個分頁" },
      { keys: ["⌘", "`"], label: "終端機" },
      { keys: ["⌘", "⇧", "P"], label: "命令面板" },
    ],
  },
  cta: {
    title: "純粹的程式碼，純粹的專注。",
    sub: "以 MIT 授權免費開源。正式版本通過驗證並發布後，即可在這裡下載。",
    button: "前往版本頁下載",
    note: "下載目標平台：Windows 11 x64 與 macOS 14+ Apple Silicon arm64。Linux 版本規劃中。",
    unavailable: "尚未設定版本下載入口。",
    versionLabel: "版本",
    stages: {
      preview: "開發預覽版",
      candidate: "正式版候選",
      published: "已發布版本",
    },
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "以 Tauri、SolidJS、CodeMirror 6 與 Rust 打造。MIT 授權。",
  },
};

const dictionaries: Record<Locale, Dict> = { en, "zh-Hant": zhHant };

export function t(): Dict {
  return dictionaries[locale()];
}

export const languageNames = [
  "TypeScript", "JavaScript", "TSX", "JSX", "Rust", "Python", "Go", "Java", "C", "C++",
  "C#", "HTML", "CSS", "JSON", "Markdown", "Shell", "YAML", "TOML", "SQL",
];
