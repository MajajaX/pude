import { locale, type Locale } from "./i18n-runtime";
import { HOME_COPY } from "./site";
import { BENCHMARK, formatSeconds, type SizeKey } from "./benchmark";

export { locale, localeHref } from "./i18n-runtime";
export type { Locale } from "./i18n-runtime";

export type FilmChapter = "open" | "edit" | "save" | "git" | "terminal" | "markdown";

const en = {
  nav: {
    sections: "Sections",
    showcase: "Tour",
    features: "Features",
    architecture: "Architecture",
    compare: "Compare",
    philosophy: "Philosophy",
    docs: "Docs",
    download: "Download",
  },
  hero: {
    ...HOME_COPY.en,
    ctaPrimary: "Get pude",
    ctaSecondary: "How it stays light",
    note: "Windows 11 x64 · macOS 14+ Apple Silicon · Linux planned.",
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
    text: "AI can quickly write a lot of code, but you still want to see what changed (even if it's just a glance). pude makes that step quicker: open a folder, review the diff, maybe show off your craft with a few edits by hand, then head back and tell your agent to commit!",
  },
  showcase: {
    eyebrow: "The tour",
    title: "Take a look. Make an edit.",
    sub: "A tour of the native editor. Keep scrolling to move through the views.",
    steps: [
      {
        k: "editor",
        title: "Your code, front and center",
        desc: "Tabs, pinning, find and replace, plus project text and file search. The file tree loads folders on expand, with optional Git-ignored grouping.",
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
        desc: "Right-click a file or folder to open a terminal in its directory. Each tab starts its own PTY on first view and keeps running while the panel is hidden.",
      },
      {
        k: "markdown",
        title: "Markdown, rendered",
        desc: "Switch source and preview from the editor’s lower-right corner. Preview uses the available width with clear text in both themes.",
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
        desc: "Opening a workspace reads only its top level. Folders load on expand; project search, parsers and terminals load when you use them.",
        meta: "list_dir(\"src/\") · on expand",
      },
      {
        k: "02",
        title: "Local-first",
        desc: "Files stay at their local paths, without an account or cloud sync. Update checks are optional; Git, terminals and approved plugins can also use the network.",
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
  compare: {
    eyebrow: "pude vs VS Code",
    title: "Light, measured.",
    sub: "pude next to Visual Studio Code on the same Mac, opening the same folder.",
    highlights: {
      installerMacos: "smaller download",
      sizeOnDisk: "smaller on disk",
      memory: "less memory",
      launch: "faster to ready",
    },
    versus: "vs",
    sizes: {
      title: "Size and memory",
      unit: "Each dot is 5 MB, rounded up.",
      labels: {
        installerMacos: "Installer download · macOS",
        installerWindows: "Installer download · Windows x64",
        sizeOnDisk: "Size on disk",
        memory: "Memory with a folder open",
      } as Record<SizeKey, string>,
    },
    launch: {
      title: "Launch timeline",
      unit: `Median of ${BENCHMARK.runs} launches, in seconds.`,
      starting: "Starting",
      drawing: "Window shown, still drawing",
      ready: "Ready",
      tip: (window: number, ready: number) => `Window ${formatSeconds(window)} · ready ${formatSeconds(ready)}`,
    },
    table: {
      summary: "Show the numbers",
      metric: "Measurement",
      difference: "Difference",
      windowShown: "First window on screen",
      ready: "Launch until ready",
      times: (ratio: string) => `${ratio}×`,
    },
    method: `pude ${BENCHMARK.pudeVersion} and Visual Studio Code ${BENCHMARK.vscodeVersion}, measured on ${BENCHMARK.date} on ${BENCHMARK.machine}. Both open the pude repository; VS Code uses a fresh profile with no extensions added. Installer sizes are the official downloads. Launch time runs until the window stops changing and memory is the physical footprint of the app and all its helper processes 15 seconds after launch, each the median of ${BENCHMARK.runs} runs. Reproduce it with scripts/benchmark/compare-vscode.mjs.`,
  },
  languages: {
    eyebrow: "Syntax",
    title: "Highlighting for the languages you use, parsed on your machine.",
  },
  philosophy: {
    eyebrow: "Philosophy",
    title: "Keep the human part light.",
    sub: "Read the code, review the change, make your edit. A small core leaves room for the tools already doing the heavy work.",
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
      { keys: ["⌘", "⇧", "F"], label: "Search project" },
      { keys: ["⌘", "⌥", "F"], label: "Replace" },
      { keys: ["⌘", "G"], label: "Go to line" },
      { keys: ["⌘", "W"], label: "Close tab" },
      { keys: ["⌃", "⇥"], label: "Next tab" },
      { keys: ["⌘", "`"], label: "Terminal" },
      { keys: ["⌘", "⇧", "P"], label: "Commands" },
    ],
  },
  cta: {
    title: "A lighter way to take a look.",
    sub: "Free and open source under the MIT License.",
    button: "Choose an installer",
    buttons: { windows: "Download for Windows x64", macos: "Download for macOS Apple Silicon" },
    selectInstaller: "Select an installer",
    auto: "Auto-detect",
    requirements: {
      windows: "For Windows 11 on an x64 PC. This installer is unsigned.",
      macos: "For macOS 14 or later on Apple Silicon (M1 or newer). Signed and notarized.",
    },
    recommendations: {
      choose: "Choose an installer for your computer. You can always select either platform below.",
      windowsRecommended: "Windows 11 or later on x64 detected. The Windows installer is recommended.",
      windowsConfirm: "Windows detected. Before downloading, confirm that your PC runs Windows 11 on x64.",
      macosRecommended: "macOS 14 or later on Apple Silicon detected. The macOS installer is recommended.",
      macosConfirm: "macOS detected. Before downloading, confirm macOS 14 or later and an Apple Silicon chip (M1 or newer).",
      windowsUnsupported: "This Windows version or CPU is outside our Windows 11 x64 release target. Choose an installer for a supported computer below.",
      macosUnsupported: "This Mac is outside our macOS 14+ Apple Silicon release target. Choose an installer for a supported computer below.",
      unsupported: "pude is available for Windows 11 x64 and macOS 14+ Apple Silicon. Choose an installer for your desktop computer below.",
    },
    github: "View on GitHub",
    allReleases: "All releases and checksums",
    note: "Windows 11 x64 (unsigned) · macOS 14+ Apple Silicon (signed and notarized). Linux is planned.",
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
    compare: "比較",
    philosophy: "設計理念",
    docs: "文件",
    download: "下載",
  },
  hero: {
    ...HOME_COPY["zh-Hant"],
    ctaPrimary: "取得 pude",
    ctaSecondary: "它如何保持輕量",
    note: "Windows 11 x64 · macOS 14+ Apple Silicon · Linux 規劃中。",
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
    text: "AI 可以快速寫下大段程式碼，但你仍想看看它改了什麼(或許只是瞄一眼)。pude 讓這步更快：打開資料夾、檢視差異、也許還能展示手藝親手修幾行，然後回去告訴 Agent 可以提交了！",
  },
  showcase: {
    eyebrow: "功能導覽",
    title: "看一眼，改幾行。",
    sub: "原生編輯器功能導覽。繼續往下捲動，逐一瀏覽。",
    steps: [
      {
        k: "editor",
        title: "程式碼永遠是主角",
        desc: "支援分頁、釘選、尋找與取代，以及專案文字與檔案搜尋。檔案樹展開時才載入資料夾，也能切換 Git 忽略項目分組。",
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
        desc: "對檔案或資料夾按右鍵，即可在所在目錄開啟終端機。每個分頁首次顯示時才啟動自己的 PTY，面板隱藏時仍持續執行。",
      },
      {
        k: "markdown",
        title: "Markdown，即時渲染",
        desc: "從編輯器右下角切換原始碼與預覽。預覽充分使用可用寬度，深淺主題的內文都清晰易讀。",
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
        desc: "開啟工作區只讀取最上層；展開時才載入資料夾，專案搜尋、解析器與終端機都在使用時才載入。",
        meta: "list_dir(\"src/\") · on expand",
      },
      {
        k: "02",
        title: "本地優先",
        desc: "檔案留在原本的路徑，不需要帳號或雲端同步。更新檢查可以關閉；Git、終端機與核准的外掛也能連網。",
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
  compare: {
    eyebrow: "pude vs VS Code",
    title: "輕，有數據為證。",
    sub: "在同一台 Mac 上開啟同一個資料夾，與 Visual Studio Code 並排比較。",
    highlights: {
      installerMacos: "下載檔更小",
      sizeOnDisk: "安裝後空間更小",
      memory: "記憶體用量更少",
      launch: "更快可以開始用",
    },
    versus: "對比",
    sizes: {
      title: "檔案大小與記憶體",
      unit: "每個點代表 5 MB，無條件進位。",
      labels: {
        installerMacos: "安裝檔下載 · macOS",
        installerWindows: "安裝檔下載 · Windows x64",
        sizeOnDisk: "安裝後佔用空間",
        memory: "開啟資料夾後的記憶體",
      },
    },
    launch: {
      title: "啟動時間軸",
      unit: `${BENCHMARK.runs} 次啟動的中位數，單位為秒。`,
      starting: "啟動中",
      drawing: "視窗已出現，仍在繪製",
      ready: "可以使用",
      tip: (window, ready) => `視窗 ${formatSeconds(window)} · 可用 ${formatSeconds(ready)}`,
    },
    table: {
      summary: "查看數據表",
      metric: "項目",
      difference: "差距",
      windowShown: "第一個視窗出現",
      ready: "從啟動到可用",
      times: (ratio) => `${ratio} 倍`,
    },
    method: `pude ${BENCHMARK.pudeVersion} 與 Visual Studio Code ${BENCHMARK.vscodeVersion}，${BENCHMARK.date} 於 ${BENCHMARK.machine} 實測。兩者都開啟 pude 原始碼資料夾；VS Code 使用全新設定檔、未額外安裝擴充套件。安裝檔大小取自官方下載。啟動時間計算到視窗畫面不再變化為止；記憶體為啟動 15 秒後，程式與所有輔助程序的實體記憶體佔用（physical footprint）總和。兩者皆取 ${BENCHMARK.runs} 次的中位數。可用 scripts/benchmark/compare-vscode.mjs 重現。`,
  },
  languages: {
    eyebrow: "語法突顯",
    title: "你常用的語言都有突顯，全部在本機解析。",
  },
  philosophy: {
    eyebrow: "設計理念",
    title: "把人的這一步，做得更輕。",
    sub: "讀程式碼、看變更、親手修改。維持精簡的核心，把資源留給正在處理繁重工作的工具。",
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
      { keys: ["⌘", "⇧", "F"], label: "專案搜尋" },
      { keys: ["⌘", "⌥", "F"], label: "取代" },
      { keys: ["⌘", "G"], label: "跳至行號" },
      { keys: ["⌘", "W"], label: "關閉分頁" },
      { keys: ["⌃", "⇥"], label: "下一個分頁" },
      { keys: ["⌘", "`"], label: "終端機" },
      { keys: ["⌘", "⇧", "P"], label: "命令面板" },
    ],
  },
  cta: {
    title: "下次想看一眼，就打開 pude。",
    sub: "以 MIT 授權免費開源。",
    button: "選擇安裝檔",
    buttons: { windows: "下載 Windows x64 版", macos: "下載 macOS Apple Silicon 版" },
    selectInstaller: "選擇安裝檔",
    auto: "自動推薦",
    requirements: {
      windows: "適用 Windows 11、x64 處理器的電腦。此安裝檔未簽署。",
      macos: "適用 macOS 14 以上、Apple Silicon（M1 或更新晶片）的 Mac。已簽署並公證。",
    },
    recommendations: {
      choose: "請依電腦系統選擇安裝檔，也可以在下方手動選擇平台。",
      windowsRecommended: "偵測到 Windows 11 以上與 x64 處理器，推薦下載 Windows 版。",
      windowsConfirm: "偵測到 Windows；下載前請確認電腦使用 Windows 11 與 x64 處理器。",
      macosRecommended: "偵測到 macOS 14 以上與 Apple Silicon，推薦下載 macOS 版。",
      macosConfirm: "偵測到 macOS；下載前請確認為 macOS 14 以上與 Apple Silicon（M1 或更新晶片）。",
      windowsUnsupported: "偵測到的 Windows 版本或處理器不在 Windows 11 x64 的發行支援範圍內。可在下方替其他電腦選擇安裝檔。",
      macosUnsupported: "偵測到的 Mac 不在 macOS 14 以上、Apple Silicon 的發行支援範圍內。可在下方替其他電腦選擇安裝檔。",
      unsupported: "pude 提供 Windows 11 x64 與 macOS 14 以上 Apple Silicon 版本。請在下方替桌面電腦選擇安裝檔。",
    },
    github: "在 GitHub 上查看",
    allReleases: "所有版本與校驗碼",
    note: "Windows 11 x64（未簽署）· macOS 14 以上 Apple Silicon（已簽署並公證）。Linux 版規劃中。",
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
