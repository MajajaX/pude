import { For, Show } from "solid-js";
import { BENCHMARK, formatMegabytes, formatRatio, formatSeconds, sizeMetric, type LaunchTimes } from "../benchmark";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";

const MEGABYTES_PER_DOT = 5;
const DOT_COLUMNS = 40;
const TIMELINE_SECONDS = 1.2;
const TIMELINE_TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2];

type Series = "pude" | "vscode";
const SERIES_NAMES: Record<Series, string> = { pude: "pude", vscode: "VS Code" };

function percentOfTimeline(seconds: number) {
  return `${(seconds / TIMELINE_SECONDS) * 100}%`;
}

function Legend() {
  return (
    <span class="compare-legend">
      <For each={["pude", "vscode"] as Series[]}>
        {(series) => (
          <span class="compare-legend-item">
            <span class={`compare-swatch is-${series}`} aria-hidden="true" />
            {SERIES_NAMES[series]}
          </span>
        )}
      </For>
    </span>
  );
}

function Highlights() {
  const launch = BENCHMARK.launch;
  const highlights = () => {
    const download = sizeMetric("installerMacos");
    const disk = sizeMetric("sizeOnDisk");
    const memory = sizeMetric("memory");
    const copy = t().compare.highlights;
    return [
      { ratio: formatRatio(download.pude, download.vscode), label: copy.installerMacos, pude: formatMegabytes(download.pude), vscode: formatMegabytes(download.vscode) },
      { ratio: formatRatio(disk.pude, disk.vscode), label: copy.sizeOnDisk, pude: formatMegabytes(disk.pude), vscode: formatMegabytes(disk.vscode) },
      { ratio: formatRatio(memory.pude, memory.vscode), label: copy.memory, pude: formatMegabytes(memory.pude), vscode: formatMegabytes(memory.vscode) },
      { ratio: formatRatio(launch.pude.ready, launch.vscode.ready), label: copy.launch, pude: formatSeconds(launch.pude.ready), vscode: formatSeconds(launch.vscode.ready) },
    ];
  };
  return (
    <div class="compare-highlights">
      <For each={highlights()}>
        {(highlight, i) => (
          <div class="compare-highlight" use:reveal style={{ "--reveal-delay": `${i() * 80}ms` }}>
            <span class="compare-highlight-value">{highlight.ratio}×</span>
            <span class="compare-highlight-label">{highlight.label}</span>
            <span class="compare-highlight-detail">
              {highlight.pude} {t().compare.versus} {highlight.vscode}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function Dots(props: { megabytes: number; series: Series }) {
  const count = () => Math.ceil(props.megabytes / MEGABYTES_PER_DOT);
  const fullRows = () => Math.floor(count() / DOT_COLUMNS);
  const remainder = () => count() % DOT_COLUMNS;
  return (
    <span class={`compare-dots is-${props.series}`} aria-hidden="true">
      <Show when={fullRows() > 0}>
        <span class="compare-dots-block" style={{ "--cols": DOT_COLUMNS, "--rows": fullRows() }} />
      </Show>
      <Show when={remainder() > 0}>
        <span class="compare-dots-block" style={{ "--cols": remainder(), "--rows": 1 }} />
      </Show>
    </span>
  );
}

function SizeChart() {
  return (
    <article class="compare-card" use:reveal>
      <header class="compare-card-head">
        <h3>{t().compare.sizes.title}</h3>
        <Legend />
      </header>
      <p class="compare-card-unit">{t().compare.sizes.unit}</p>
      <div class="compare-size-grid" style={{ "--columns": DOT_COLUMNS }}>
        <For each={BENCHMARK.sizes}>
          {(metric, i) => (
            <div class="compare-size" style={{ "--reveal-delay": `${i() * 120}ms` }}>
              <h4>{t().compare.sizes.labels[metric.key]}</h4>
              <For each={["pude", "vscode"] as Series[]}>
                {(series) => (
                  <div class="compare-size-row">
                    <span class="compare-size-name">
                      <span class={`compare-swatch is-${series}`} aria-hidden="true" />
                      {SERIES_NAMES[series]}
                      <span class="compare-size-value">{formatMegabytes(metric[series])}</span>
                    </span>
                    <Dots megabytes={metric[series]} series={series} />
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </article>
  );
}

function TimelineLane(props: { series: Series; times: LaunchTimes }) {
  return (
    <div class={`compare-lane is-${props.series}`} tabindex="0" aria-label={`${SERIES_NAMES[props.series]}: ${t().compare.launch.tip(props.times.window, props.times.ready)}`}>
      <span class="compare-lane-name">
        <span class={`compare-swatch is-${props.series}`} aria-hidden="true" />
        {SERIES_NAMES[props.series]}
      </span>
      <div class="compare-lane-track" aria-hidden="true">
        <span class="compare-lane-starting" style={{ width: percentOfTimeline(props.times.window) }} />
        <span
          class="compare-lane-drawing"
          style={{ left: percentOfTimeline(props.times.window), width: percentOfTimeline(props.times.ready - props.times.window) }}
        />
        <span class="compare-lane-ready" style={{ left: percentOfTimeline(props.times.ready) }} />
        <span class="compare-lane-label" style={{ left: percentOfTimeline(props.times.ready) }}>
          {formatSeconds(props.times.ready)}
        </span>
        <span class="compare-lane-tip">{t().compare.launch.tip(props.times.window, props.times.ready)}</span>
      </div>
    </div>
  );
}

function LaunchChart() {
  return (
    <article class="compare-card" use:reveal>
      <header class="compare-card-head">
        <h3>{t().compare.launch.title}</h3>
        <Legend />
      </header>
      <p class="compare-card-unit">{t().compare.launch.unit}</p>
      <div class="compare-timeline">
        <TimelineLane series="pude" times={BENCHMARK.launch.pude} />
        <TimelineLane series="vscode" times={BENCHMARK.launch.vscode} />
        <div class="compare-axis" aria-hidden="true">
          <For each={TIMELINE_TICKS}>
            {(tick, i) => (
              <span classList={{ "is-minor": i() % 2 === 1 }} style={{ left: percentOfTimeline(tick) }}>
                {tick === 0 ? "0" : tick.toFixed(1)}
              </span>
            )}
          </For>
        </div>
      </div>
      <div class="compare-timeline-key">
        <span><span class="compare-key-starting" aria-hidden="true" />{t().compare.launch.starting}</span>
        <span><span class="compare-key-drawing" aria-hidden="true" />{t().compare.launch.drawing}</span>
        <span><span class="compare-key-ready" aria-hidden="true" />{t().compare.launch.ready}</span>
      </div>
    </article>
  );
}

function DataTable() {
  const copy = () => t().compare.table;
  const rows = () => {
    const { pude, vscode } = BENCHMARK.launch;
    return [
      ...BENCHMARK.sizes.map((metric) => ({
        label: t().compare.sizes.labels[metric.key],
        pude: formatMegabytes(metric.pude),
        vscode: formatMegabytes(metric.vscode),
        ratio: formatRatio(metric.pude, metric.vscode),
      })),
      { label: copy().windowShown, pude: formatSeconds(pude.window), vscode: formatSeconds(vscode.window), ratio: formatRatio(pude.window, vscode.window) },
      { label: copy().ready, pude: formatSeconds(pude.ready), vscode: formatSeconds(vscode.ready), ratio: formatRatio(pude.ready, vscode.ready) },
    ];
  };
  return (
    <details class="compare-table">
      <summary>{copy().summary}</summary>
      <div class="compare-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{copy().metric}</th>
              <th scope="col">pude {BENCHMARK.pudeVersion}</th>
              <th scope="col">VS Code {BENCHMARK.vscodeVersion}</th>
              <th scope="col">{copy().difference}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr>
                  <th scope="row">{row.label}</th>
                  <td>{row.pude}</td>
                  <td>{row.vscode}</td>
                  <td>{copy().times(row.ratio)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function Compare() {
  return (
    <section id="compare" class="compare">
      <div class="wrap">
        <div use:reveal>
          <span class="eyebrow">{t().compare.eyebrow}</span>
          <h2 class="section-title">{t().compare.title}</h2>
          <p class="section-sub">{t().compare.sub}</p>
        </div>
        <Highlights />
        <div class="compare-charts">
          <SizeChart />
          <LaunchChart />
        </div>
        <DataTable />
        <p class="compare-method">{t().compare.method}</p>
      </div>
    </section>
  );
}
