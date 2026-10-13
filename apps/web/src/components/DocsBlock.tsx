import { For, Match, Show, Switch } from "solid-js";
import type { DocBlock } from "../i18n-docs";
import { blockSource, highlightLine, inlineParts } from "../lib/docs-source";
import { scroll } from "../lib/scroll-progress";

export type DocsViewMode = "preview" | "source";

type BlockProps = {
  block: DocBlock;
  line: number;
  anchor?: string;
  mode: DocsViewMode;
  releaseAvailable: boolean;
  downloadHref: string;
  downloadLabel: string;
};

function Inline(props: { text: string }) {
  return (
    <For each={inlineParts(props.text)}>{(part) => (part.code ? <code>{part.text}</code> : <>{part.text}</>)}</For>
  );
}

function SourceInline(props: { text: string }) {
  return (
    <For each={inlineParts(props.text)}>
      {(part) => (part.code ? <span class="md-code">{part.raw}</span> : <>{part.raw}</>)}
    </For>
  );
}

function CodeLine(props: { line: string; lang: string }) {
  return (
    <For each={highlightLine(props.line, props.lang)}>
      {(token) => <span class={`tk-${token.kind}`}>{token.text}</span>}
    </For>
  );
}

function SourceLine(props: { block: DocBlock; text: string; index: number; count: number }) {
  const kind = () => props.block.t;
  const isFence = () => kind() === "code" && (props.index === 0 || props.index === props.count - 2);
  const headingMarker = () => (kind() === "h2" ? "##" : "###");

  return (
    <Switch fallback={<SourceInline text={props.text} />}>
      <Match when={props.text === ""}>{""}</Match>
      <Match when={kind() === "h2" || kind() === "h3"}>
        <span class="md-heading">
          <span class="md-mark">{headingMarker()}</span>
          {props.text.slice(headingMarker().length)}
        </span>
      </Match>
      <Match when={isFence()}>
        <span class="md-fence">{props.text}</span>
      </Match>
      <Match when={kind() === "code"}>
        <CodeLine line={props.text} lang={(props.block as { lang: string }).lang} />
      </Match>
      <Match when={kind() === "list"}>
        <span class="md-mark">-</span>
        <SourceInline text={props.text.slice(1)} />
      </Match>
      <Match when={kind() === "note" || kind() === "release-status"}>
        <span class="md-mark">{">"}</span>
        <span class="md-quote">
          <SourceInline text={props.text.slice(1)} />
        </span>
      </Match>
      <Match when={kind() === "table"}>
        <For each={props.text.split(/(\|)/)}>
          {(cell) => (cell === "|" ? <span class="md-pipe">|</span> : <SourceInline text={cell} />)}
        </For>
      </Match>
    </Switch>
  );
}

function SourceBlock(props: BlockProps) {
  const lines = () => blockSource(props.block, props.releaseAvailable);
  return (
    <For each={lines()}>
      {(text, i) => (
        <div class="src-line" data-line={props.line + i()}>
          <SourceLine block={props.block} text={text} index={i()} count={lines().length} />
        </div>
      )}
    </For>
  );
}

function PreviewBlock(props: BlockProps) {
  const block = () => props.block;
  const text = () => (block() as { text: string }).text;

  return (
    <Switch>
      <Match when={block().t === "h2"}>
        <h2 class="doc-h2">
          <span class="doc-h2-text">{text()}</span>
        </h2>
      </Match>
      <Match when={block().t === "h3"}>
        <h3 class="doc-h3">{text()}</h3>
      </Match>
      <Match when={block().t === "p"}>
        <p class="doc-p">
          <Inline text={text()} />
        </p>
      </Match>
      <Match when={block().t === "code"}>
        <pre class="doc-code">
          <span class="doc-code-lang">{(block() as { lang: string }).lang}</span>
          <code>
            <For each={(block() as { code: string }).code.split("\n")}>
              {(line, i) => (
                <span class="doc-code-line" style={{ "--i": i() }}>
                  <CodeLine line={line} lang={(block() as { lang: string }).lang} />
                </span>
              )}
            </For>
          </code>
        </pre>
      </Match>
      <Match when={block().t === "list"}>
        <ul class="doc-list" style={{ "--n": (block() as { items: string[] }).items.length }}>
          <For each={(block() as { items: string[] }).items}>
            {(item, i) => (
              <li style={{ "--i": i() }}>
                <Inline text={item} />
              </li>
            )}
          </For>
        </ul>
      </Match>
      <Match when={block().t === "table"}>
        <div class="doc-table-wrap">
          <table class="doc-table" style={{ "--n": (block() as { rows: string[][] }).rows.length }}>
            <thead>
              <tr>
                <For each={(block() as { head: string[] }).head}>{(cell) => <th>{cell}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={(block() as { rows: string[][] }).rows}>
                {(row, i) => (
                  <tr style={{ "--i": i() }}>
                    <For each={row}>
                      {(cell) => (
                        <td>
                          <Inline text={cell} />
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Match>
      <Match when={block().t === "note"}>
        <aside class="doc-note">
          <Inline text={text()} />
        </aside>
      </Match>
      <Match when={block().t === "release-status"}>
        <aside class="doc-note">
          {props.releaseAvailable
            ? (block() as { available: string }).available
            : (block() as { unavailable: string }).unavailable}{" "}
          <a href={props.downloadHref}>{props.downloadLabel}</a>
        </aside>
      </Match>
    </Switch>
  );
}

export default function DocsBlock(props: BlockProps) {
  return (
    <div
      class={`doc-block doc-block-${props.block.t}`}
      id={props.anchor}
      data-line={props.line}
      use:scroll="appear"
    >
      <Show when={props.mode === "source"} fallback={<PreviewBlock {...props} />}>
        <SourceBlock {...props} />
      </Show>
    </div>
  );
}
