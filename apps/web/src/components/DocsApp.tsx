import { createEffect, createSignal, For, Index, onCleanup, onMount } from "solid-js";
import { locale, localeHref, t, type DocBlock } from "../i18n-docs";
import packageInfo from "../../package.json";
import { getReleaseUrlForVersion, getReleaseStage, REPOSITORY_URL } from "../release-info";
import { blockLineNumbers, blockSource } from "../lib/docs-source";
import { scroll } from "../lib/scroll-progress";
import BrandMark from "./BrandMark";
import DocsBlock, { type DocsViewMode } from "./DocsBlock";
import LanguageToggle from "./LanguageToggle";

/** The line, as a share of the viewport height, that decides what is being read. */
const READING_LINE = 0.4;

const releaseUrl = getReleaseUrlForVersion(import.meta.env.VITE_RELEASE_URL, packageInfo.version);
const releaseStage = getReleaseStage(packageInfo.version, releaseUrl);
const releaseAvailable = releaseStage === "published";

/** Approximate rendered height of a block, in wrapped source lines, for the minimap. */
function minimapWeight(block: DocBlock) {
  return blockSource(block, releaseAvailable).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 90)), 0);
}

export default function DocsApp() {
  const [mode, setMode] = createSignal<DocsViewMode>("preview");
  const [current, setCurrent] = createSignal("overview");
  const [currentLine, setCurrentLine] = createSignal(1);
  const [percent, setPercent] = createSignal(0);
  const [viewportShare, setViewportShare] = createSignal(0.1);
  const [readProgress, setReadProgress] = createSignal<Record<string, number>>({});

  const sections = () => t().docsPage.sections;
  const currentSection = () => sections().find((section) => section.id === current()) ?? sections()[0];
  const outline = () =>
    currentSection()
      .blocks.map((block, index) => ({ block, index }))
      .filter(({ block }) => block.t === "h3");
  const anchorFor = (sectionId: string, index: number) => `${sectionId}-${index}`;
  const downloadHref = () => (locale() === "zh-Hant" ? "./index.zh-Hant.html#download" : "./#download");
  const homeHref = () => localeHref("home", locale());

  let frame: number | undefined;
  let tabsElement: HTMLElement | undefined;
  let currentElement: HTMLElement | undefined;

  const updateReadingState = () => {
    frame = undefined;
    const readingLine = window.innerHeight * READING_LINE;
    const pageHeight = document.documentElement.scrollHeight;
    const scrollable = pageHeight - window.innerHeight;
    setPercent(scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 0);
    setViewportShare(Math.min(1, window.innerHeight / pageHeight));

    const files = [...document.querySelectorAll<HTMLElement>(".doc-file")];
    const activeFile = files.filter((file) => file.getBoundingClientRect().top <= readingLine).at(-1) ?? files[0];
    if (!activeFile) return;
    setCurrent(activeFile.id);

    let line = 1;
    let lineElement: HTMLElement | undefined;
    for (const element of activeFile.querySelectorAll<HTMLElement>("[data-line]")) {
      if (element.getBoundingClientRect().top > readingLine) break;
      line = Number(element.dataset.line);
      lineElement = element;
    }
    setCurrentLine(line);
    if (lineElement !== currentElement) {
      currentElement?.classList.remove("is-current");
      lineElement?.classList.add("is-current");
      currentElement = lineElement;
    }
  };

  const scheduleUpdate = () => {
    frame ??= window.requestAnimationFrame(updateReadingState);
  };

  /** Switch views while keeping the block being read at the same place on screen. */
  const switchMode = (next: DocsViewMode) => {
    if (next === mode()) return;
    const anchor = currentElement?.closest<HTMLElement>(".doc-block");
    const before = anchor?.getBoundingClientRect().top ?? 0;
    setMode(next);
    if (anchor) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: "instant" });
    currentElement = undefined;
    scheduleUpdate();
  };

  const jumpFromMinimap = (event: MouseEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: share * scrollable, behavior: "smooth" });
  };

  createEffect(() => {
    const id = current();
    const tab = tabsElement?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!tab || !tabsElement || tabsElement.scrollWidth <= tabsElement.clientWidth) return;
    tabsElement.scrollTo({ left: tab.offsetLeft - (tabsElement.clientWidth - tab.offsetWidth) / 2, behavior: "smooth" });
  });

  createEffect(() => {
    locale();
    mode();
    if (typeof window !== "undefined") scheduleUpdate();
  });

  onMount(() => {
    updateReadingState();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
  });
  onCleanup(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  });

  return (
    <>
      <div class="site-bg" aria-hidden="true" />
      <header class="ed-titlebar">
        <a class="brand" href={homeHref()}>
          <BrandMark />
          <span class="brand-name">pude</span>
          <span class="brand-sub">docs</span>
        </a>
        <div class="ed-crumb" aria-hidden="true">
          <span>pude-docs</span>
          <i>/</i>
          <span class="ed-crumb-file">{currentSection().file}</span>
        </div>
        <div class="ed-titlebar-right">
          <LanguageToggle page="docs" />
          <a class="ed-back" href={REPOSITORY_URL}>
            GitHub
          </a>
          <a class="ed-back" href={homeHref()}>
            ← <span>{t().docsPage.back}</span>
          </a>
        </div>
        <span class="nav-progress" aria-hidden="true" />
      </header>

      <div class="ed-shell">
        <aside class="ed-sidebar">
          <p class="ed-pane-title">{t().docsPage.explorer}</p>
          <div class="ed-folder" aria-hidden="true">
            <span class="ed-chevron" />
            pude-docs
          </div>
          <nav class="ed-files" aria-label={t().docsPage.explorer}>
            <For each={sections()}>
              {(section) => (
                <a
                  href={`#${section.id}`}
                  class="ed-file"
                  classList={{ active: current() === section.id }}
                  aria-current={current() === section.id ? "location" : undefined}
                  style={{ "--r": readProgress()[section.id] ?? 0 }}
                >
                  <span class="ed-file-icon" aria-hidden="true">
                    MD
                  </span>
                  <span class="ed-file-name">{section.file}</span>
                  <span class="ed-file-nav">{section.nav}</span>
                </a>
              )}
            </For>
          </nav>
          <p class="ed-pane-title">{t().docsPage.outline}</p>
          <nav class="ed-outline" aria-label={t().docsPage.outline}>
            <For each={outline()}>
              {(item) => (
                <a href={`#${anchorFor(currentSection().id, item.index)}`}>
                  {(item.block as { text: string }).text}
                </a>
              )}
            </For>
          </nav>
        </aside>

        <main class="ed-main">
          <nav class="ed-tabs" ref={tabsElement} aria-label={t().docsPage.explorer}>
            <For each={sections()}>
              {(section) => (
                <a
                  href={`#${section.id}`}
                  class="ed-tab"
                  data-id={section.id}
                  classList={{ active: current() === section.id }}
                  style={{ "--r": readProgress()[section.id] ?? 0 }}
                >
                  <span class="ed-file-icon" aria-hidden="true">
                    MD
                  </span>
                  {section.file}
                </a>
              )}
            </For>
          </nav>

          <article class="ed-doc" classList={{ "is-source": mode() === "source" }}>
            <header class="doc-intro">
              <h1 class="docs-title">
                <span class="md-mark" aria-hidden="true">
                  #
                </span>
                {t().docsPage.title}
              </h1>
              <p class="docs-sub">{t().docsPage.sub}</p>
              <p class="docs-version">
                {t().docsPage.versionLabel} {packageInfo.version} · {t().docsPage.stages[releaseStage]}
              </p>
            </header>

            <For each={sections()}>
              {(section) => {
                const lineNumbers = blockLineNumbers(section.blocks, releaseAvailable);
                return (
                <section
                  id={section.id}
                  class="doc-file"
                  use:scroll={{
                    mode: "read",
                    onProgress: (progress) => setReadProgress((all) => ({ ...all, [section.id]: progress })),
                  }}
                >
                  <div class="doc-file-head" use:scroll="appear">
                    <span class="ed-file-icon" aria-hidden="true">
                      MD
                    </span>
                    {section.file}
                    <span class="doc-file-rule" aria-hidden="true" />
                  </div>
                  <Index each={section.blocks}>
                    {(block, i) => (
                      <DocsBlock
                        block={block()}
                        line={lineNumbers[i]}
                        anchor={block().t === "h3" ? anchorFor(section.id, i) : undefined}
                        mode={mode()}
                        releaseAvailable={releaseAvailable}
                        downloadHref={downloadHref()}
                        downloadLabel={t().docsPage.downloadLabel}
                      />
                    )}
                  </Index>
                </section>
                );
              }}
            </For>

            <footer class="doc-end">
              <BrandMark size={20} />
              <span>{t().footer.tagline}</span>
              <span>{t().footer.built}</span>
            </footer>
          </article>
        </main>

        <aside class="ed-minimap" aria-hidden="true" onClick={jumpFromMinimap}>
          <For each={sections()}>
            {(section) => (
              <div
                class="ed-minimap-file"
                classList={{ active: current() === section.id }}
                style={{ "flex-grow": section.blocks.reduce((total, block) => total + minimapWeight(block), 0) }}
              >
                <For each={section.blocks}>
                  {(block) => <i class={`mm-${block.t}`} style={{ "flex-grow": minimapWeight(block) }} />}
                </For>
              </div>
            )}
          </For>
          <span class="ed-minimap-view" style={{ "--view": viewportShare() }} />
        </aside>
      </div>

      <footer class="ed-status">
        <span class="ed-status-brand">
          <span class="ed-status-dot" />
          {t().docsPage.versionLabel} {packageInfo.version} · {t().docsPage.stages[releaseStage]}
        </span>
        <span class="ed-status-spacer" />
        <span>
          Ln {currentLine()}, Col 1
        </span>
        <span>{percent()}%</span>
        <span class="ed-status-wide">UTF-8</span>
        <span class="ed-status-wide">LF</span>
        <span class="ed-status-wide">Markdown</span>
        <div class="ed-mode" role="group" aria-label={t().docsPage.viewMode}>
          <button type="button" aria-pressed={mode() === "source"} onClick={() => switchMode("source")}>
            {t().docsPage.source}
          </button>
          <button type="button" aria-pressed={mode() === "preview"} onClick={() => switchMode("preview")}>
            {t().docsPage.preview}
          </button>
        </div>
      </footer>
    </>
  );
}
