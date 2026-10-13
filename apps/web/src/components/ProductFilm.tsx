import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { t, type FilmChapter } from "../i18n";
import BrandMark from "./BrandMark";
import {
  chapterDurations,
  chapterOrder,
  lineLength,
  mainTs,
  readmeSource,
  sliceTokens,
  terminalCommand,
  terminalOutput,
  typedLength,
  type Token,
} from "./product-film-script";

const chapterStarts = chapterOrder.map((_, i) =>
  chapterOrder.slice(0, i).reduce((total, chapter) => total + chapterDurations[chapter], 0),
);
const filmLength = chapterStarts.at(-1)! + chapterDurations[chapterOrder.at(-1)!];

const addedLineOffsets = mainTs.map((_, i) =>
  mainTs.slice(0, i).filter((line) => line.added).reduce((total, line) => total + lineLength(line) + 1, 0),
);

const diffRows = (() => {
  let left = 0;
  let right = 0;
  return mainTs.map((line) => ({
    tokens: line.tokens,
    added: !!line.added,
    left: line.added ? undefined : ++left,
    right: ++right,
  }));
})().slice(4);

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function Tokens(props: { tokens: Token[] }) {
  return <For each={props.tokens}>{([kind, text]) => <span class={`tk-${kind}`}>{text}</span>}</For>;
}

export default function ProductFilm() {
  const [time, setTime] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);
  let reducedMotion = false;

  const index = createMemo(() => {
    let i = 0;
    while (i < chapterStarts.length - 1 && time() >= chapterStarts[i + 1]) i++;
    return i;
  });
  const chapter = () => chapterOrder[index()];
  const progress = () => (time() - chapterStarts[index()]) / chapterDurations[chapter()];

  /** True once playback has reached `from` (0–1) of the given chapter. */
  const reached = (target: FilmChapter, from = 0) => {
    const targetIndex = chapterOrder.indexOf(target);
    return index() > targetIndex || (index() === targetIndex && progress() >= from);
  };
  const during = (target: FilmChapter, from: number, to: number) =>
    chapter() === target && progress() >= from && progress() < to;

  const folderOpen = createMemo(() => reached("open", 0.24));
  const rootListed = createMemo(() => reached("open", 0.32));
  const srcExpanded = createMemo(() => reached("open", 0.64));
  const readingSrc = createMemo(() => during("open", 0.5, 0.64));
  const fileOpen = createMemo(() => reached("edit"));
  const readmeOpen = createMemo(() => chapter() === "markdown");
  const showPreview = createMemo(() => during("markdown", 0.45, 1));
  const gitTab = createMemo(() => chapter() === "git");
  const diffOpen = createMemo(() => during("git", 0.26, 1));
  const terminalOpen = createMemo(() => during("terminal", 0.1, 1));
  const saved = createMemo(() => reached("save", 0.4));
  const savedToast = createMemo(() => during("save", 0.4, 1));

  const typed = createMemo(() => {
    if (chapter() === "edit") return Math.floor(clamp01((progress() - 0.1) / 0.78) * typedLength);
    return reached("edit") ? typedLength : 0;
  });
  const dirty = createMemo(() => (chapter() === "edit" && typed() > 0) || during("save", 0, 0.4));
  const showCursor = createMemo(() => chapter() === "edit" || chapter() === "save");

  const visibleChars = (i: number) => {
    const line = mainTs[i];
    if (!line.added) return lineLength(line);
    const available = typed() - addedLineOffsets[i];
    return available >= 1 ? Math.min(lineLength(line), available - 1) : -1;
  };
  const cursorLine = createMemo(() => {
    let cursor = 5;
    mainTs.forEach((line, i) => {
      if (line.added && visibleChars(i) >= 0) cursor = i;
    });
    return cursor;
  });
  const cursorPosition = createMemo(() => {
    const row = mainTs.slice(0, cursorLine() + 1).filter((_, i) => visibleChars(i) >= 0).length;
    return `Ln ${row}, Col ${visibleChars(cursorLine()) + 1}`;
  });

  const commandChars = createMemo(() =>
    chapter() === "terminal" ? Math.floor(clamp01((progress() - 0.2) / 0.2) * terminalCommand.length) : 0,
  );

  const keycap = createMemo(() => {
    if (during("open", 0.04, 0.22)) return ["⌘", "K", "⌘", "O"];
    if (during("save", 0.12, 0.5)) return ["⌘", "S"];
    if (during("terminal", 0, 0.26)) return ["⌘", "`"];
    return undefined;
  });

  const chapterFill = (i: number) => (i < index() ? 1 : i === index() ? progress() : 0);

  let frame: number | undefined;
  let lastFrameTime: number | undefined;
  let onScreen = false;

  const step = (now: number) => {
    if (lastFrameTime !== undefined) {
      const elapsed = Math.min(now - lastFrameTime, 64);
      setTime((value) => (value + elapsed) % filmLength);
    }
    lastFrameTime = now;
    frame = window.requestAnimationFrame(step);
  };

  const syncClock = () => {
    const shouldRun = playing() && onScreen && !document.hidden;
    if (shouldRun && frame === undefined) {
      lastFrameTime = undefined;
      frame = window.requestAnimationFrame(step);
    } else if (!shouldRun && frame !== undefined) {
      window.cancelAnimationFrame(frame);
      frame = undefined;
    }
  };

  const togglePlaying = () => {
    setPlaying(!playing());
    syncClock();
  };

  const selectChapter = (i: number) => {
    const start = chapterStarts[i];
    setTime(reducedMotion ? start + chapterDurations[chapterOrder[i]] - 1 : start);
  };

  let root: HTMLElement | undefined;

  onMount(() => {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setPlaying(false);
      selectChapter(1);
    }

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      syncClock();
    });
    if (root) observer.observe(root);
    document.addEventListener("visibilitychange", syncClock);

    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncClock);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    });
  });

  const treeRows = () => [
    { name: "pude-demo", depth: 0, icon: "", folder: true, open: true, show: folderOpen() },
    { name: "src", depth: 1, icon: "", folder: true, open: srcExpanded(), show: rootListed() },
    { name: "main.ts", depth: 2, icon: "TS", show: srcExpanded(), badge: saved() ? "M" : "" },
    { name: "editor.ts", depth: 2, icon: "TS", show: srcExpanded() },
    { name: "styles.css", depth: 2, icon: "CSS", show: srcExpanded() },
    { name: "README.md", depth: 1, icon: "MD", show: rootListed() },
    { name: "package.json", depth: 1, icon: "{}", show: rootListed() },
  ];
  const selectedFile = () => (readmeOpen() ? "README.md" : fileOpen() ? "main.ts" : "");

  return (
    <figure class="film" ref={root} aria-label={t().film.ariaLabel}>
      <div class="film-window" aria-hidden="true">
        <div class="film-titlebar">
          <span class="film-brand">
            <BrandMark size={16} class="film-brand-mark" />
            pude
          </span>
          <span class="film-crumb" classList={{ on: folderOpen() }}>
            pude-demo <i>/</i> main
          </span>
          <span class="film-lights">
            <i />
            <i />
            <i />
          </span>
        </div>

        <div class="film-body">
          <aside class="film-sidebar">
            <div class="film-sidetabs">
              <span classList={{ active: !gitTab() }}>{t().film.explorer}</span>
              <span classList={{ active: gitTab() }}>{t().film.git}</span>
            </div>
            <div class="film-panel" classList={{ active: !gitTab() }}>
              <Index each={treeRows()}>
                {(row, i) => (
                  <div
                    class="film-row"
                    classList={{
                      show: row().show,
                      folder: !!row().folder,
                      open: !!row().open,
                      selected: selectedFile() === row().name,
                    }}
                    style={{ "--depth": row().depth, "--d": i }}
                  >
                    <span class="film-row-icon">{row().icon}</span>
                    <span class="film-row-name">{row().name}</span>
                    <Show when={row().badge}>
                      <span class="film-badge">{row().badge}</span>
                    </Show>
                  </div>
                )}
              </Index>
              <div class="film-loading" classList={{ on: readingSrc() }}>
                <span class="film-spinner" />
                {t().film.loading}
              </div>
            </div>
            <div class="film-panel film-git" classList={{ active: gitTab() }}>
              <div class="film-branch">⎇ main</div>
              <div class="film-git-head">
                {t().film.changes} <span>1</span>
              </div>
              <div class="film-row show selected">
                <span class="film-row-icon">TS</span>
                <span class="film-row-name">main.ts</span>
                <span class="film-row-path">src</span>
                <span class="film-badge">M</span>
              </div>
              <div class="film-commit">Message</div>
            </div>
          </aside>

          <section class="film-main">
            <div class="film-tabs">
              <span class="film-tab" classList={{ show: fileOpen(), active: !readmeOpen() }}>
                <i class="tk-fn">TS</i> {diffOpen() ? "main.ts ↔ HEAD" : "main.ts"}
                <b classList={{ dirty: dirty() }} />
              </span>
              <span class="film-tab" classList={{ show: readmeOpen(), active: readmeOpen() }}>
                <i class="tk-v">MD</i> README.md
                <b />
              </span>
            </div>

            <div class="film-view">
              <div class="film-empty" classList={{ active: !fileOpen() }}>
                <BrandMark size={58} class="film-empty-mark" />
                <p>pure code editor</p>
                <span class="film-button" classList={{ pressed: during("open", 0.14, 0.24) }}>
                  {t().film.openFolder}
                </span>
              </div>

              <div class="film-code" classList={{ active: fileOpen() && !readmeOpen() && !diffOpen() }}>
                <Index each={mainTs}>
                  {(line, i) => (
                    <div
                      class="film-line"
                      classList={{ shown: visibleChars(i) >= 0, current: showCursor() && cursorLine() === i }}
                    >
                      <span class="film-line-text">
                        <Tokens tokens={sliceTokens(line().tokens, visibleChars(i))} />
                        <Show when={showCursor() && cursorLine() === i}>
                          <span class="film-caret" />
                        </Show>
                      </span>
                    </div>
                  )}
                </Index>
              </div>

              <div class="film-diff" classList={{ active: diffOpen() }}>
                <For each={diffRows}>
                  {(row, i) => (
                    <div class="film-diff-row" classList={{ added: row.added }} style={{ "--d": i() }}>
                      <span class="film-diff-num">{row.left ?? ""}</span>
                      <span class="film-diff-cell left">{row.added ? "" : <Tokens tokens={row.tokens} />}</span>
                      <span class="film-diff-num">{row.right}</span>
                      <span class="film-diff-cell right">
                        <Show when={row.added}>
                          <em>+</em>
                        </Show>
                        <Tokens tokens={row.tokens} />
                      </span>
                    </div>
                  )}
                </For>
              </div>

              <div class="film-markdown" classList={{ active: readmeOpen(), preview: showPreview() }}>
                <div class="film-md-source">
                  <For each={readmeSource}>
                    {(line) => (
                      <div class="film-line shown" classList={{ heading: line.startsWith("#") }}>
                        <span class="film-line-text">{line}</span>
                      </div>
                    )}
                  </For>
                </div>
                <div class="film-md-preview">
                  <h4>pude-demo</h4>
                  <p>
                    A tiny workspace for <strong>pude</strong>.
                  </p>
                  <ul>
                    <li>Open a folder</li>
                    <li>Edit and save</li>
                    <li>Review Git</li>
                  </ul>
                </div>
              </div>
            </div>

            <div class="film-terminal" classList={{ open: terminalOpen() }}>
              <div class="film-terminal-tabs">
                <span class="active">{t().film.terminal} 1</span>
                <span>+</span>
              </div>
              <div class="film-terminal-body">
                <div>
                  <span class="tk-str">~/pude-demo</span> <span class="tk-fn">(main)</span> ${" "}
                  {terminalCommand.slice(0, commandChars())}
                  <Show when={commandChars() < terminalCommand.length || progress() < 0.5}>
                    <span class="film-caret block" />
                  </Show>
                </div>
                <For each={terminalOutput}>
                  {(line) => (
                    <div class={`film-out ${line.kind}`} classList={{ show: terminalOpen() && progress() >= line.at }}>
                      {line.text}
                    </div>
                  )}
                </For>
              </div>
            </div>
          </section>
        </div>

        <div class="film-status">
          <span classList={{ hidden: !folderOpen() }}>⎇ main</span>
          <span class="film-status-dot">local-first</span>
          <span class="film-saved" classList={{ on: savedToast() }}>
            ✓ {t().film.saved}
          </span>
          <span class="film-status-spacer" />
          <span classList={{ hidden: !showCursor() }}>{cursorPosition()}</span>
          <span class="film-md-toggle" classList={{ hidden: !readmeOpen(), preview: showPreview() }}>
            <b>{t().film.source}</b>
            <b>{t().film.preview}</b>
          </span>
          <span classList={{ hidden: !fileOpen() }}>UTF-8</span>
          <span classList={{ hidden: !fileOpen() }}>LF</span>
          <span classList={{ hidden: !fileOpen() }}>{readmeOpen() ? "Markdown" : "TypeScript"}</span>
        </div>

        <div class="film-keycap" classList={{ on: !!keycap() }}>
          <For each={keycap() ?? []}>{(key) => <kbd>{key}</kbd>}</For>
        </div>
      </div>

      <figcaption class="film-controls">
        <button
          class="film-play"
          type="button"
          onClick={togglePlaying}
          aria-label={playing() ? t().film.pause : t().film.play}
          title={playing() ? t().film.pause : t().film.play}
        >
          <span classList={{ paused: !playing() }} aria-hidden="true" />
        </button>
        <div class="film-chapters">
          <For each={t().film.chapters}>
            {(item, i) => (
              <button
                type="button"
                class="film-chapter"
                classList={{ active: index() === i() }}
                aria-current={index() === i() ? "step" : undefined}
                style={{ "--fill": chapterFill(i()) }}
                onClick={() => selectChapter(i())}
              >
                <span class="film-chapter-bar" aria-hidden="true" />
                <span class="film-chapter-label">
                  <i>{String(i() + 1).padStart(2, "0")}</i> {item.title}
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={index() + 1} keyed>
          {(chapterNumber) => <p class="film-caption">{t().film.chapters[chapterNumber - 1].caption}</p>}
        </Show>
      </figcaption>
    </figure>
  );
}
