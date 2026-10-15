import { locale, type Locale } from "./i18n-runtime";

export type DocBlock =
  | { t: "h2" | "h3"; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "list"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "release-status"; available: string; unavailable: string };

/** One documentation topic, shown in the docs editor as one Markdown file. */
export type DocSection = { id: string; file: string; nav: string; blocks: DocBlock[] };

type DocsDict = {
  docsPage: {
    title: string;
    sub: string;
    back: string;
    explorer: string;
    outline: string;
    source: string;
    preview: string;
    viewMode: string;
    versionLabel: string;
    stages: { preview: string; candidate: string; published: string };
    downloadLabel: string;
    sections: DocSection[];
  };
  footer: {
    tagline: string;
    built: string;
  };
};

const checksumCommands =
  "# macOS\nshasum -a 256 pude-macos-arm64.dmg\n\n# Windows (PowerShell)\nGet-FileHash .\\pude-windows-x64-setup.exe -Algorithm SHA256";

const pluginManifest = `{
  "id": "pude.example.document-case-toggle",
  "name": "Document Case Toggle",
  "version": "1.0.0",
  "apiVersion": "2",
  "entry": "extension.js",
  "permissions": ["editor.read", "editor.write", "commands.register", "ui.notification"],
  "activationEvents": ["onCommand:pude.example.document-case-toggle.toggleCase"],
  "contributes": {
    "commands": [
      { "command": "pude.example.document-case-toggle.toggleCase", "title": "Toggle Document Case" }
    ]
  }
}`;

const pluginEntry = `const commandId = "pude.example.document-case-toggle.toggleCase";

function toggleCase(text) {
  return text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
}

void pude.commands.register(commandId, async () => {
  const file = await pude.editor.getFileInfo();
  const text = await pude.editor.getText();

  if (text.length === 0) {
    await pude.ui.notify("The active document is empty.");
    return;
  }

  await pude.editor.applyEdits(file.revision, [
    { from: 0, to: text.length, insert: toggleCase(text) },
  ]);
  await pude.ui.notify("Document case toggled.");
});`;

const cloneCommands = "git clone <repository-url>\ncd pude\nnpm ci";
const checkCommands = "npm run check\ncargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml";

const en: DocsDict = {
  docsPage: {
    title: "Documentation",
    sub: "Install pude, learn the daily flow, and build your first plugin — read it the way you'd read it in pude.",
    back: "Back to site",
    explorer: "Explorer",
    outline: "Outline",
    source: "Source",
    preview: "Preview",
    viewMode: "Document view",
    versionLabel: "Version",
    stages: { preview: "Development preview", candidate: "Release candidate", published: "Published release" },
    downloadLabel: "Open download section",
    sections: [
      {
        id: "overview",
        file: "README.md",
        nav: "Overview",
        blocks: [
          { t: "h2", text: "Overview" },
          {
            t: "p",
            text: "pude is a local-first desktop code editor. It opens a local folder, edits text, shows Git, starts terminals on demand and loads local plugins — and keeps everything else out of the core.",
          },
          {
            t: "note",
            text: "These docs describe pude 0.1, the first public release.",
          },
          { t: "h3", text: "What 0.1 includes" },
          {
            t: "list",
            items: [
              "Local workspaces, a lazy Explorer and multiple windows",
              "Multi-tab editing, syntax highlighting, find and replace, Markdown preview",
              "Git status, commit graph, diffs and common actions through your system Git",
              "Multiple on-demand terminals backed by real PTYs",
              "Local plugins with permission review (API 2) and a restricted LSP process manager",
            ],
          },
          { t: "h3", text: "What it leaves out on purpose" },
          {
            t: "list",
            items: [
              "Project-wide indexing, a debugger or a build system",
              "AI services, cloud sync and accounts",
              "A plugin marketplace, silent automatic updates and bundled language servers",
            ],
          },
          { t: "h3", text: "Reading these docs" },
          {
            t: "p",
            text: "Each file in the Explorer is one topic. Use `Source / Preview` in the status bar to see the Markdown behind any page, exactly as pude shows it.",
          },
        ],
      },
      {
        id: "releases",
        file: "install.md",
        nav: "Install & update",
        blocks: [
          { t: "h2", text: "Install and update" },
          {
            t: "table",
            head: ["Platform", "Installer"],
            rows: [
              ["Windows 11 x64", "`pude-windows-x64-setup.exe` (unsigned)"],
              ["macOS 14+ Apple Silicon", "`pude-macos-arm64.dmg`"],
              ["Linux", "Planned"],
            ],
          },
          {
            t: "release-status",
            available: "The home page recommends an installer for your OS. Confirm Windows 11 x64 or macOS 14+ Apple Silicon when your browser hides version or CPU details; both installers remain available to choose manually.",
            unavailable: "No verified release download is configured yet. Downloads stay disabled until a release is published and verified.",
          },
          { t: "h3", text: "Verify a download" },
          {
            t: "p",
            text: "Each release ships `SHA256SUMS.txt`, covering both installers and the license files. Compare the checksum before you install:",
          },
          { t: "code", lang: "bash", code: checksumCommands },
          { t: "h3", text: "Updates" },
          {
            t: "p",
            text: "pude looks for a newer version on GitHub Releases about five seconds after startup, and again when you click Check for updates in the About dialog. Turn the startup check off with Check for updates on startup in Settings. pude never downloads or installs an update by itself: you choose Download update, then Restart and update. You can also close pude, download the newer installer and run it.",
          },
          { t: "note", text: "Releases are published as stable versions only." },
        ],
      },
      {
        id: "usage",
        file: "using-pude.md",
        nav: "Using pude",
        blocks: [
          { t: "h2", text: "Using pude" },
          { t: "h3", text: "Open a workspace" },
          {
            t: "p",
            text: "Choose `Open folder` (`⌘K ⌘O`, or `Ctrl+K Ctrl+O` on Windows) and pick a local directory. Only the top level is read; folders load as you expand them. A fresh start shows your recent projects, and every new window keeps its own workspace, tabs and terminals.",
          },
          { t: "h3", text: "Explorer" },
          {
            t: "list",
            items: [
              "Create, rename and delete files and folders. Deleting moves items to the Recycle Bin or Trash — never a permanent delete.",
              "Right-click for `Copy Path`, `Copy Relative Path` and revealing the item in your file manager.",
              "Long folders stay fast: only visible rows are rendered.",
            ],
          },
          { t: "h3", text: "Edit" },
          {
            t: "list",
            items: [
              "Tabs support drag to reorder, pinning, middle-click close, Close Others, Close to the Right and reopening a closed tab.",
              "Find and replace with case, regex and whole-word options; `⌘G` jumps to a line.",
              "Multiple cursors, undo and redo, and indentation come from CodeMirror 6.",
              "Hold `⌘` (or `Ctrl`) and scroll over the editor to set the font size between 11 and 24.",
              "Markdown opens as source; switch to a rendered preview with `Source / Preview` in the status bar.",
            ],
          },
          { t: "h3", text: "Files pude opens" },
          {
            t: "list",
            items: [
              "UTF-8 and UTF-8 with BOM. Invalid UTF-8 and other encodings are refused rather than silently converted.",
              "Files over 5 MiB open in large-file mode: editing and search stay on, heavy parsing and preview turn off.",
              "Text files are limited to 20 MiB. Supported images open in an image preview.",
            ],
          },
          { t: "h3", text: "Saving safely" },
          {
            t: "p",
            text: "Saves are queued per file and replace it atomically. Every line keeps its original LF or CRLF ending. If a file changes on disk while you have unsaved edits, pude offers `Compare`, `Reload` or `Keep Editor Version` — it never overwrites either side silently.",
          },
          {
            t: "p",
            text: "Unsaved work is checkpointed locally for recovery. Recovery restores the last completed checkpoint, not every keystroke.",
          },
        ],
      },
      {
        id: "git",
        file: "git.md",
        nav: "Git",
        blocks: [
          { t: "h2", text: "Git" },
          {
            t: "p",
            text: "pude uses the Git installed on your system, so `git` must be on your `PATH`. Without Git, editing keeps working and the Git panel says it is unavailable.",
          },
          { t: "h3", text: "Status and history" },
          {
            t: "list",
            items: [
              "Switch the sidebar to `GIT` for the branch plus staged, unstaged, untracked, renamed and conflicted files.",
              "The commit graph handles detached HEAD, unborn branches and multiple refs, and loads older history on demand.",
              "Open any change as a side-by-side or stacked diff.",
            ],
          },
          { t: "h3", text: "Actions" },
          {
            t: "p",
            text: "Stage and unstage, commit, push and pull, create, switch or safely delete branches, stash and pop. When a command fails, the full Git output opens in a dialog instead of a toast that disappears.",
          },
          {
            t: "note",
            text: "The panel refreshes from events — saves, file changes and Git actions — never from background polling. Full rebase and merge-resolution interfaces are not included yet.",
          },
        ],
      },
      {
        id: "terminal",
        file: "terminal.md",
        nav: "Terminal",
        blocks: [
          { t: "h2", text: "Terminal" },
          {
            t: "p",
            text: "Toggle the panel with `` ⌘` `` (`` Ctrl+` `` on Windows) and add as many tabs as you need. Each tab loads xterm.js and starts its own PTY the first time it is shown.",
          },
          {
            t: "list",
            items: [
              "Hiding the panel keeps sessions running. Closing a tab, switching workspace or closing the window stops that tab's process tree.",
              "Windows uses `ComSpec`, falling back to `powershell.exe`. macOS and Linux use `SHELL`, falling back to `/bin/sh`.",
              "If the workspace has a Python virtual environment in `.venv`, `venv` or `env`, new terminals activate it.",
              "Scrollback keeps 5,000 lines. ANSI colors, the alternate screen, mouse tracking, CJK text and IME input work as expected.",
            ],
          },
          {
            t: "note",
            text: "Terminals run with your user's permissions. They are not a sandbox: commands can reach files outside the workspace and the network.",
          },
        ],
      },
      {
        id: "settings",
        file: "settings.md",
        nav: "Settings & data",
        blocks: [
          { t: "h2", text: "Settings and local data" },
          {
            t: "table",
            head: ["Setting", "What it does"],
            rows: [
              ["Font size", "Editor text size. `⌘` + scroll changes it too."],
              ["Tab size", "Width used for tabs and indentation."],
              ["Word wrap", "Wraps long lines inside the editor."],
              ["Hide dot files", "Hides names starting with `.` in the Explorer."],
              ["Watcher excluded paths", "Paths the file watcher ignores, such as build output."],
            ],
          },
          { t: "h3", text: "Where your data lives" },
          {
            t: "list",
            items: [
              "Workspace files stay at their own paths. pude never copies them elsewhere.",
              "Settings and session metadata are kept in local WebView storage.",
              "Recovery checkpoints use IndexedDB with a local fallback. Clearing app storage can remove them.",
              "Installed plugins are copied into the app data directory.",
            ],
          },
        ],
      },
      {
        id: "shortcuts",
        file: "shortcuts.md",
        nav: "Shortcuts",
        blocks: [
          { t: "h2", text: "Keyboard shortcuts" },
          {
            t: "table",
            head: ["Action", "macOS", "Windows"],
            rows: [
              ["Save", "`⌘S`", "`Ctrl+S`"],
              ["Save as", "`⌘⇧S`", "`Ctrl+Shift+S`"],
              ["Save all", "`⌘⌥S`", "`Ctrl+Alt+S`"],
              ["Open file", "`⌘O`", "`Ctrl+O`"],
              ["Open folder", "`⌘K ⌘O`", "`Ctrl+K Ctrl+O`"],
              ["Close tab", "`⌘W`", "`Ctrl+W`"],
              ["Next / previous tab", "`⌃⇥` / `⌃⇧⇥`", "`Ctrl+Tab` / `Ctrl+Shift+Tab`"],
              ["Find", "`⌘F`", "`Ctrl+F`"],
              ["Replace", "`⌘⌥F`", "`Ctrl+H`"],
              ["Go to line", "`⌘G`", "`Ctrl+G`"],
              ["Command palette", "`⌘⇧P`", "`Ctrl+Shift+P`"],
              ["Toggle terminal", "`` ⌘` ``", "`` Ctrl+` ``"],
              ["Font size", "`⌘` + scroll", "`Ctrl` + scroll"],
            ],
          },
          { t: "note", text: "Custom key bindings are planned." },
        ],
      },
      {
        id: "plugins",
        file: "plugins.md",
        nav: "Plugins",
        blocks: [
          { t: "h2", text: "Building a plugin" },
          {
            t: "p",
            text: "A plugin is a local folder with a `plugin.json` manifest and a JavaScript entry. It runs in a Web Worker inside an opaque-origin sandbox and reaches pude only through the asynchronous `pude` API — no DOM, CodeMirror, Tauri or browser storage.",
          },
          {
            t: "note",
            text: "Plugins are executable code you choose to trust. Permissions are deny-by-default and reviewed before install, but the sandbox is not a complete OS security boundary. Install only plugins whose source you trust.",
          },
          { t: "h3", text: "1. Write the manifest" },
          {
            t: "p",
            text: "This is the runnable example from `examples/plugins/document-case-toggle`. Every contributed command needs a matching `onCommand:<id>` event; `onLanguage:<id>`, `onFileOpen`, `onFileSave` and `onWorkspaceOpen` are also available.",
          },
          { t: "code", lang: "json", code: pluginManifest },
          { t: "h3", text: "2. Write the entry" },
          { t: "code", lang: "js", code: pluginEntry },
          { t: "h3", text: "3. Install and iterate" },
          {
            t: "list",
            items: [
              "Open `Plugins`, choose `Install local plugin` and select the folder.",
              "Review the requested permissions and approve only what the plugin needs. `Cancel` keeps the current version and grants.",
              "Enable the plugin and run its command from the command palette.",
              "After editing, use `Update from folder`. The new version replaces the old one only after you approve it.",
            ],
          },
          { t: "h3", text: "API at a glance" },
          {
            t: "table",
            head: ["Permission", "Calls", "Notes"],
            rows: [
              ["`editor.read`", "`getText`, `getTextRange`, `getSelection`, `getCursor`, `getFileInfo`", "Up to 128 Ki code units per call"],
              ["`editor.write`", "`applyEdits(revision, edits)`", "Up to 1,000 edits; normal undo and dirty state"],
              ["`workspace.read`", "`list`, `readFile`, `getFileInfo`, `readFileRange`", "128 KiB per read; ranges for larger files"],
              ["`workspace.write`", "`writeFile`", "Conflict-checked; never deletes"],
              ["`commands.register`", "`commands.register`", "Declared commands only"],
              ["`ui.*`", "`ui.notify`, `ui.statusBar`, `ui.quickPick`", "Rendered by pude, bounded text"],
              ["`git.read`", "`git.getStatus`, `git.getDiff`", "Read only"],
              ["`terminal.write`", "`terminal.write`", "Only terminals the user opened"],
              ["`network`", "`network.fetch`", "HTTPS to approved domains"],
              ["`process.spawn:lsp`", "`lsp.start`, `send`, `cancel`, `stop`", "Declared servers only"],
            ],
          },
          {
            t: "p",
            text: "Each run allows 512 concurrent requests, 20 requests per second, a 30-second timeout, 64 KiB requests and 1 MiB responses. The full reference lives in `docs/plugin-api-v2.md`.",
          },
        ],
      },
      {
        id: "installation",
        file: "build.md",
        nav: "Build from source",
        blocks: [
          { t: "h2", text: "Build from source" },
          {
            t: "list",
            items: [
              "Node.js `22.12+`, `24+` or `26+` with npm `10.9+` (Node.js 24 recommended)",
              "Rust stable through `rustup`, and Git on `PATH`",
              "macOS: Xcode Command Line Tools · Windows: MSVC C++ build tools and WebView2 · Linux: the Tauri GTK/WebKit packages",
            ],
          },
          { t: "code", lang: "bash", code: cloneCommands },
          { t: "h3", text: "Commands" },
          {
            t: "table",
            head: ["Command", "Purpose"],
            rows: [
              ["`npm run tauri:dev`", "Run the native desktop app"],
              ["`npm run dev`", "Desktop UI in a browser shell (port 5173)"],
              ["`npm run web:dev`", "This website (port 5174)"],
              ["`npm test`", "Desktop Vitest suite"],
              ["`npm run tauri:build`", "Native bundles for the current platform"],
            ],
          },
          {
            t: "note",
            text: "The browser shell uses an in-memory demo workspace. It does not exercise native files, Git, terminals or plugin installation.",
          },
          { t: "h3", text: "Before a pull request" },
          { t: "code", lang: "bash", code: checkCommands },
        ],
      },
    ] satisfies DocSection[],
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "Built with Tauri, SolidJS, CodeMirror 6 and Rust. MIT licensed.",
  },
};

const zhHant: DocsDict = {
  docsPage: {
    title: "使用文件",
    sub: "安裝 pude、熟悉日常流程，再動手寫第一個外掛——就像在 pude 裡閱讀一樣。",
    back: "返回首頁",
    explorer: "檔案",
    outline: "大綱",
    source: "原始碼",
    preview: "預覽",
    viewMode: "文件檢視方式",
    versionLabel: "版本",
    stages: { preview: "開發預覽版", candidate: "正式版候選", published: "已發布版本" },
    downloadLabel: "開啟首頁下載區",
    sections: [
      {
        id: "overview",
        file: "README.md",
        nav: "總覽",
        blocks: [
          { t: "h2", text: "總覽" },
          {
            t: "p",
            text: "pude 是本地優先的桌面程式碼編輯器。它開啟本機資料夾、編輯文字、呈現 Git、按需啟動終端機並載入本機外掛——其餘的一律不放進核心。",
          },
          {
            t: "note",
            text: "本文件描述 pude 0.1，也就是第一個公開版本。",
          },
          { t: "h3", text: "0.1 包含什麼" },
          {
            t: "list",
            items: [
              "本機工作區、按需載入的檔案總管與多視窗",
              "多分頁編輯、語法突顯、尋找與取代、Markdown 預覽",
              "透過系統 Git 呈現狀態、提交圖譜、差異與常用操作",
              "以真實 PTY 運作、按需啟動的多個終端機",
              "具權限審核的本機外掛（API 2）與受控 LSP 程序管理器",
            ],
          },
          { t: "h3", text: "刻意不做什麼" },
          {
            t: "list",
            items: [
              "全專案索引、除錯器或建置系統",
              "AI 服務、雲端同步與帳號",
              "外掛市集、靜默自動更新與內附語言伺服器",
            ],
          },
          { t: "h3", text: "如何閱讀本文件" },
          {
            t: "p",
            text: "檔案總管裡的每個檔案就是一個主題。用狀態列的 `Source / Preview` 切換，就能看到每一頁背後的 Markdown，與 pude 顯示的完全相同。",
          },
        ],
      },
      {
        id: "releases",
        file: "install.md",
        nav: "安裝與更新",
        blocks: [
          { t: "h2", text: "安裝與更新" },
          {
            t: "table",
            head: ["平台", "安裝檔"],
            rows: [
              ["Windows 11 x64", "`pude-windows-x64-setup.exe`（未簽署）"],
              ["macOS 14+ Apple Silicon", "`pude-macos-arm64.dmg`"],
              ["Linux", "規劃中"],
            ],
          },
          {
            t: "release-status",
            available: "首頁下載區會依作業系統推薦安裝檔。瀏覽器隱藏版本或處理器資訊時，請確認為 Windows 11 x64 或 macOS 14 以上 Apple Silicon；也能手動選擇兩種安裝檔。",
            unavailable: "尚未設定經核實的版本下載入口；正式版本發布並通過驗證前，下載入口會保持停用。",
          },
          { t: "h3", text: "驗證下載檔" },
          {
            t: "p",
            text: "每個版本都附有 `SHA256SUMS.txt`，涵蓋兩個安裝檔與授權文件。安裝前請先比對雜湊值：",
          },
          { t: "code", lang: "bash", code: checksumCommands },
          { t: "h3", text: "更新" },
          {
            t: "p",
            text: "pude 會在啟動後約五秒，以及你在「關於」視窗按下「Check for updates」時，到 GitHub Releases 查詢新版本。可在設定中關閉「Check for updates on startup」。pude 不會自行下載或安裝更新：你需要先選擇「Download update」，再選擇「Restart and update」；也可以關閉 pude，下載較新的安裝檔並執行。",
          },
          { t: "note", text: "發布的版本一律為穩定版。" },
        ],
      },
      {
        id: "usage",
        file: "using-pude.md",
        nav: "使用教學",
        blocks: [
          { t: "h2", text: "使用教學" },
          { t: "h3", text: "開啟工作區" },
          {
            t: "p",
            text: "選擇 `Open folder`（`⌘K ⌘O`，Windows 為 `Ctrl+K Ctrl+O`）並挑選本機資料夾。pude 只讀取最上層，展開時才載入子資料夾。全新啟動會顯示最近的專案；每個新視窗都有自己的工作區、分頁與終端機。",
          },
          { t: "h3", text: "檔案總管" },
          {
            t: "list",
            items: [
              "建立、重新命名與刪除檔案和資料夾。刪除會移到資源回收筒或垃圾桶，絕不永久刪除。",
              "右鍵選單提供 `Copy Path`、`Copy Relative Path`，以及在系統檔案管理器中顯示。",
              "很長的資料夾也保持流暢：只渲染看得到的列。",
            ],
          },
          { t: "h3", text: "編輯" },
          {
            t: "list",
            items: [
              "分頁支援拖曳排序、釘選、中鍵關閉、關閉其他、關閉右側，以及重新開啟剛關閉的分頁。",
              "尋找與取代支援大小寫、正規表示式與全字比對；`⌘G` 跳至指定行。",
              "多游標、復原與重做、縮排由 CodeMirror 6 提供。",
              "按住 `⌘`（或 `Ctrl`）在編輯器上捲動滾輪，可將字體大小調整為 11 到 24。",
              "Markdown 預設顯示原始碼；用狀態列的 `Source / Preview` 切換為渲染預覽。",
            ],
          },
          { t: "h3", text: "可開啟的檔案" },
          {
            t: "list",
            items: [
              "UTF-8 與含 BOM 的 UTF-8。無效的 UTF-8 或其他編碼會被拒絕，不會默默轉碼。",
              "超過 5 MiB 的檔案以大型檔案模式開啟：保留編輯與搜尋，關閉重型解析與預覽。",
              "文字檔上限為 20 MiB；支援的圖片會以圖片預覽開啟。",
            ],
          },
          { t: "h3", text: "安全地儲存" },
          {
            t: "p",
            text: "每個檔案的儲存會依序排隊，並以原子化方式取代原檔。每一行都保留原本的 LF 或 CRLF。若檔案在你尚未儲存時被外部修改，pude 會提供 `Compare`、`Reload` 或 `Keep Editor Version`——絕不默默覆寫任何一方。",
          },
          {
            t: "p",
            text: "未儲存的內容會在本機建立復原檢查點。復原會還原最後一次完成的檢查點，而不是每一次按鍵。",
          },
        ],
      },
      {
        id: "git",
        file: "git.md",
        nav: "Git",
        blocks: [
          { t: "h2", text: "Git" },
          {
            t: "p",
            text: "pude 使用你系統上安裝的 Git，因此 `git` 必須在 `PATH` 中。沒有 Git 時仍可正常編輯，Git 面板會顯示無法使用。",
          },
          { t: "h3", text: "狀態與歷史" },
          {
            t: "list",
            items: [
              "把側邊欄切到 `GIT`，即可看到分支，以及已暫存、未暫存、未追蹤、已重新命名與衝突的檔案。",
              "提交圖譜能處理 detached HEAD、尚無提交的分支與多個 refs，並按需載入更早的歷史。",
              "任何變更都能以並排或堆疊方式檢視差異。",
            ],
          },
          { t: "h3", text: "操作" },
          {
            t: "p",
            text: "暫存與取消暫存、提交、推送與拉取、建立／切換／安全刪除分支、stash 與 pop。指令失敗時，完整的 Git 輸出會顯示在對話框中，而不是一閃即逝的提示。",
          },
          {
            t: "note",
            text: "面板由事件觸發更新——儲存、檔案變更與 Git 操作——從不在背景輪詢。目前尚未提供完整的 rebase 與合併衝突解決介面。",
          },
        ],
      },
      {
        id: "terminal",
        file: "terminal.md",
        nav: "終端機",
        blocks: [
          { t: "h2", text: "終端機" },
          {
            t: "p",
            text: "用 `` ⌘` ``（Windows 為 `` Ctrl+` ``）切換面板，需要幾個分頁就開幾個。每個分頁第一次顯示時，才會載入 xterm.js 並啟動自己的 PTY。",
          },
          {
            t: "list",
            items: [
              "隱藏面板時工作階段仍會執行。關閉分頁、切換工作區或關閉視窗，會停止該分頁的程序樹。",
              "Windows 使用 `ComSpec`，未設定時改用 `powershell.exe`；macOS 與 Linux 使用 `SHELL`，未設定時改用 `/bin/sh`。",
              "若工作區的 `.venv`、`venv` 或 `env` 中有 Python 虛擬環境，新終端機會自動啟用它。",
              "scrollback 保留 5,000 行，支援 ANSI 色彩、alternate screen、滑鼠追蹤、中日韓文字與輸入法。",
            ],
          },
          {
            t: "note",
            text: "終端機以你的使用者權限執行，並不是沙箱：指令可以存取工作區外的檔案，也可以連網。",
          },
        ],
      },
      {
        id: "settings",
        file: "settings.md",
        nav: "設定與資料",
        blocks: [
          { t: "h2", text: "設定與本機資料" },
          {
            t: "table",
            head: ["設定", "作用"],
            rows: [
              ["Font size", "編輯器字體大小，也可以用 `⌘` + 滾輪調整。"],
              ["Tab size", "Tab 與縮排的寬度。"],
              ["Word wrap", "在編輯器內自動換行。"],
              ["Hide dot files", "在檔案總管中隱藏以 `.` 開頭的名稱。"],
              ["Watcher excluded paths", "檔案監看要忽略的路徑，例如建置輸出。"],
            ],
          },
          { t: "h3", text: "資料存放位置" },
          {
            t: "list",
            items: [
              "工作區檔案留在原本的路徑，pude 不會複製到其他地方。",
              "設定與工作階段資訊存放在本機 WebView 儲存空間。",
              "復原檢查點使用 IndexedDB，並有本機備援；清除應用程式儲存空間可能會移除它們。",
              "已安裝的外掛會複製到應用程式資料目錄。",
            ],
          },
        ],
      },
      {
        id: "shortcuts",
        file: "shortcuts.md",
        nav: "快捷鍵",
        blocks: [
          { t: "h2", text: "鍵盤快捷鍵" },
          {
            t: "table",
            head: ["動作", "macOS", "Windows"],
            rows: [
              ["儲存", "`⌘S`", "`Ctrl+S`"],
              ["另存新檔", "`⌘⇧S`", "`Ctrl+Shift+S`"],
              ["全部儲存", "`⌘⌥S`", "`Ctrl+Alt+S`"],
              ["開啟檔案", "`⌘O`", "`Ctrl+O`"],
              ["開啟資料夾", "`⌘K ⌘O`", "`Ctrl+K Ctrl+O`"],
              ["關閉分頁", "`⌘W`", "`Ctrl+W`"],
              ["下一個／上一個分頁", "`⌃⇥` / `⌃⇧⇥`", "`Ctrl+Tab` / `Ctrl+Shift+Tab`"],
              ["尋找", "`⌘F`", "`Ctrl+F`"],
              ["取代", "`⌘⌥F`", "`Ctrl+H`"],
              ["跳至行號", "`⌘G`", "`Ctrl+G`"],
              ["命令面板", "`⌘⇧P`", "`Ctrl+Shift+P`"],
              ["切換終端機", "`` ⌘` ``", "`` Ctrl+` ``"],
              ["字體大小", "`⌘` + 滾輪", "`Ctrl` + 滾輪"],
            ],
          },
          { t: "note", text: "自訂快捷鍵規劃中。" },
        ],
      },
      {
        id: "plugins",
        file: "plugins.md",
        nav: "外掛",
        blocks: [
          { t: "h2", text: "製作外掛" },
          {
            t: "p",
            text: "外掛是一個本機資料夾，包含 `plugin.json` 宣告檔與一個 JavaScript 進入點。它在 opaque-origin 沙箱裡的 Web Worker 中執行，只能透過非同步的 `pude` API 與 pude 溝通——無法取得 DOM、CodeMirror、Tauri 或瀏覽器儲存空間。",
          },
          {
            t: "note",
            text: "外掛是你選擇信任的可執行程式碼。權限預設拒絕，安裝前會經過審核，但沙箱並不是完整的作業系統安全邊界。請只安裝來源可信的外掛。",
          },
          { t: "h3", text: "1. 撰寫宣告檔" },
          {
            t: "p",
            text: "以下是 `examples/plugins/document-case-toggle` 中可直接執行的範例。每個貢獻的命令都需要對應的 `onCommand:<id>` 事件；另外也可使用 `onLanguage:<id>`、`onFileOpen`、`onFileSave` 與 `onWorkspaceOpen`。",
          },
          { t: "code", lang: "json", code: pluginManifest },
          { t: "h3", text: "2. 撰寫進入點" },
          { t: "code", lang: "js", code: pluginEntry },
          { t: "h3", text: "3. 安裝與迭代" },
          {
            t: "list",
            items: [
              "開啟 `Plugins`，選擇 `Install local plugin` 並選取資料夾。",
              "檢視要求的權限，只核准外掛真正需要的。按 `Cancel` 會保留現有版本與授權。",
              "啟用外掛，並從命令面板執行它的命令。",
              "修改後使用 `Update from folder`；新版本要在你核准後才會取代舊版本。",
            ],
          },
          { t: "h3", text: "API 一覽" },
          {
            t: "table",
            head: ["權限", "呼叫", "說明"],
            rows: [
              ["`editor.read`", "`getText`、`getTextRange`、`getSelection`、`getCursor`、`getFileInfo`", "每次最多 128 Ki 個字碼單位"],
              ["`editor.write`", "`applyEdits(revision, edits)`", "最多 1,000 筆編輯；走一般的復原與未儲存狀態"],
              ["`workspace.read`", "`list`、`readFile`、`getFileInfo`、`readFileRange`", "每次 128 KiB；大型檔案以範圍讀取"],
              ["`workspace.write`", "`writeFile`", "會檢查衝突；不提供刪除"],
              ["`commands.register`", "`commands.register`", "僅限已宣告的命令"],
              ["`ui.*`", "`ui.notify`、`ui.statusBar`、`ui.quickPick`", "由 pude 繪製，文字長度有限"],
              ["`git.read`", "`git.getStatus`、`git.getDiff`", "唯讀"],
              ["`terminal.write`", "`terminal.write`", "只能寫入使用者已開啟的終端機"],
              ["`network`", "`network.fetch`", "僅限核准網域的 HTTPS"],
              ["`process.spawn:lsp`", "`lsp.start`、`send`、`cancel`、`stop`", "僅限已宣告的伺服器"],
            ],
          },
          {
            t: "p",
            text: "每次執行最多 512 個並行請求、每秒 20 個請求、30 秒逾時、請求 64 KiB 與回應 1 MiB。完整參考請見儲存庫中的 `docs/plugin-api-v2.md`。",
          },
        ],
      },
      {
        id: "installation",
        file: "build.md",
        nav: "從原始碼建置",
        blocks: [
          { t: "h2", text: "從原始碼建置" },
          {
            t: "list",
            items: [
              "Node.js `22.12+`、`24+` 或 `26+`，以及 npm `10.9+`（建議 Node.js 24）",
              "透過 `rustup` 安裝的 Rust stable，以及在 `PATH` 中的 Git",
              "macOS：Xcode Command Line Tools · Windows：MSVC C++ 建置工具與 WebView2 · Linux：Tauri 需要的 GTK/WebKit 套件",
            ],
          },
          { t: "code", lang: "bash", code: cloneCommands },
          { t: "h3", text: "常用指令" },
          {
            t: "table",
            head: ["指令", "用途"],
            rows: [
              ["`npm run tauri:dev`", "執行原生桌面應用程式"],
              ["`npm run dev`", "在瀏覽器殼層中執行桌面介面（port 5173）"],
              ["`npm run web:dev`", "本網站（port 5174）"],
              ["`npm test`", "桌面版 Vitest 測試"],
              ["`npm run tauri:build`", "建置目前平台的原生安裝包"],
            ],
          },
          {
            t: "note",
            text: "瀏覽器殼層使用記憶體中的示範工作區，不會測到原生檔案、Git、終端機或外掛安裝。",
          },
          { t: "h3", text: "送出 Pull Request 前" },
          { t: "code", lang: "bash", code: checkCommands },
        ],
      },
    ] satisfies DocSection[],
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "以 Tauri、SolidJS、CodeMirror 6 與 Rust 打造。MIT 授權。",
  },
};

const dictionaries: Record<Locale, DocsDict> = { en, "zh-Hant": zhHant };

export function t(): DocsDict {
  return dictionaries[locale()];
}

export { locale, localeHref, setLocale, switchLocaleFromLink } from "./i18n-runtime";
