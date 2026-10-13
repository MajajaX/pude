import { createSignal, For } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

export default function Showcase() {
  const [active, setActive] = createSignal(0);
  const stepCount = () => t().showcase.steps.length;
  const onProgress = (progress: number) => setActive(Math.min(stepCount() - 1, Math.floor(progress * stepCount())));

  return (
    <section id="showcase" class="tour" use:scroll={{ mode: "pin", onProgress }} style={{ "--n": stepCount() }}>
      <div class="tour-sticky">
        <div class="wrap tour-grid">
          <div class="tour-copy">
            <div use:reveal>
              <span class="eyebrow">{t().showcase.eyebrow}</span>
              <h2 class="section-title">{t().showcase.title}</h2>
              <p class="section-sub">{t().showcase.sub}</p>
            </div>
            <div class="tour-steps">
              <span class="tour-rail" aria-hidden="true" />
              <For each={t().showcase.steps}>
                {(step, i) => (
                  <article class="tour-step" classList={{ active: active() === i() }}>
                    <span class="step-count">
                      {String(i() + 1).padStart(2, "0")} / {String(stepCount()).padStart(2, "0")}
                    </span>
                    <h3>{step.title}</h3>
                    <p>{step.desc}</p>
                    <img
                      class="tour-step-image"
                      src={`/shots/${step.k}.webp`}
                      alt={step.title}
                      width="1708"
                      height="979"
                      loading="lazy"
                      decoding="async"
                    />
                  </article>
                )}
              </For>
            </div>
          </div>
          <div class="tour-screens" aria-hidden="true">
            <figure class="shot-frame tour-stack">
              <For each={t().showcase.steps}>
                {(step, i) => (
                  <img
                    src={`/shots/${step.k}.webp`}
                    alt=""
                    width="1708"
                    height="979"
                    style={{ "--i": i() }}
                    loading={i() === 0 ? "eager" : "lazy"}
                    decoding="async"
                  />
                )}
              </For>
            </figure>
          </div>
        </div>
      </div>
    </section>
  );
}
