import { For } from "solid-js";
import { t } from "../i18n";
import packageInfo from "../../package.json";
import { getSiteRelease } from "../release-info";
import { scroll } from "../lib/scroll-progress";
import ProductFilm from "./ProductFilm";

export default function Hero() {
  const { stage: releaseStage } = getSiteRelease(import.meta.env.VITE_RELEASE_URL, packageInfo.version);
  const stage = () => t().cta.stages[releaseStage];

  return (
    <section class="hero" id="top">
      <div class="wrap">
        <div class="hero-copy" use:scroll="exit">
          <span class="hero-badge">
            <span class="hero-badge-dot" aria-hidden="true" />
            {t().hero.eyebrow}
          </span>
          <h1 class="hero-title">
            <span class="line">
              <span>{t().hero.titleA}</span>
            </span>
            <span class="line">
              <span class="accent">
                {t().hero.titleB}
                <i class="hero-caret" aria-hidden="true" />
              </span>
            </span>
          </h1>
          <p class="hero-sub">{t().hero.sub}</p>
          <div class="hero-ctas">
            <a class="btn-primary" href="#download">
              {t().hero.ctaPrimary}
              <span aria-hidden="true">→</span>
            </a>
            <a class="btn-ghost" href="#architecture">
              {t().hero.ctaSecondary}
            </a>
          </div>
          <ul class="hero-stack">
            <For each={t().hero.stack}>{(item) => <li>{item}</li>}</For>
          </ul>
          <p class="hero-note">{t().hero.note}</p>
          <p class="hero-version">
            {t().cta.versionLabel} {packageInfo.version} · {stage()}
          </p>
        </div>
        <div class="hero-stage" use:scroll="enter">
          <div class="hero-stage-tilt">
            <ProductFilm />
          </div>
        </div>
      </div>
    </section>
  );
}
