import { createSignal, onMount } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";
import packageInfo from "../../package.json";
import { getAssetDownloadUrl, getPublishedReleaseUrl, getReleaseStage, INSTALLERS, REPOSITORY_URL, type InstallerPlatform } from "../release-info";
import { detectDownloadRecommendation, recommendInstaller, NO_RECOMMENDATION } from "../lib/download-platform";
import BrandMark from "./BrandMark";

const releaseUrl = getPublishedReleaseUrl(import.meta.env.VITE_RELEASE_URL);
const releaseStage = getReleaseStage(packageInfo.version, releaseUrl);
const releaseAvailable = releaseStage === "published";

export default function Footer() {
  const [recommendation, setRecommendation] = createSignal(NO_RECOMMENDATION);
  const [selection, setSelection] = createSignal<InstallerPlatform | "auto">("auto");
  const platform = () => {
    const selected = selection();
    return selected === "auto" ? recommendation().platform : selected;
  };
  const recommendationText = () => {
    const selected = selection();
    return selected === "auto" ? t().cta.recommendations[recommendation().message] : t().cta.requirements[selected];
  };
  const downloadUrl = () => {
    const target = platform();
    return target && releaseUrl ? getAssetDownloadUrl(releaseUrl, INSTALLERS[target]) : releaseUrl;
  };
  const downloadLabel = () => {
    const target = platform();
    return target ? t().cta.buttons[target] : t().cta.button;
  };
  onMount(() => {
    setRecommendation(recommendInstaller(navigator));
    void detectDownloadRecommendation(navigator).then(setRecommendation);
  });

  return (
    <>
      <section class="cta" id="download" use:scroll="enter">
        <div class="cta-beam" aria-hidden="true">
          <span />
        </div>
        <div class="wrap" use:reveal>
          <h2 class="section-title">{t().cta.title}</h2>
          <p class="section-sub">{t().cta.sub}</p>
          <div class="download-selector" role="group" aria-label={t().cta.selectInstaller}>
            <button type="button" aria-pressed={selection() === "auto"} onClick={() => setSelection("auto")}>{t().cta.auto}</button>
            <button type="button" aria-pressed={selection() === "windows"} onClick={() => setSelection("windows")}>Windows x64</button>
            <button type="button" aria-pressed={selection() === "macos"} onClick={() => setSelection("macos")}>macOS Apple Silicon</button>
          </div>
          <p class="download-recommendation" aria-live="polite">
            {recommendationText()}
          </p>
          <div class="cta-actions">
            {releaseAvailable && releaseUrl ? (
              <a class="btn-primary" href={downloadUrl()}>
                {downloadLabel()}
                <span aria-hidden="true">↓</span>
              </a>
            ) : (
              <button
                class="btn-primary"
                type="button"
                disabled
                aria-describedby="download-availability"
                title={t().cta.unavailable}
              >
                {downloadLabel()}
                <span aria-hidden="true">↓</span>
              </button>
            )}
            <a class="btn-ghost" href={REPOSITORY_URL}>
              {t().cta.github}
            </a>
          </div>
          <p class="cta-note cta-version">
            {t().cta.versionLabel} {packageInfo.version} · {t().cta.stages[releaseStage]}
          </p>
          <p class="cta-note" id={!releaseAvailable ? "download-availability" : undefined}>
            {t().cta.note}
            {!releaseAvailable && <> · {t().cta.unavailable}</>}
          </p>
          {releaseAvailable && releaseUrl && (
            <>
              <div class="download-links">
                <a href={getAssetDownloadUrl(releaseUrl, INSTALLERS.windows)}>{t().cta.buttons.windows}</a>
                <a href={getAssetDownloadUrl(releaseUrl, INSTALLERS.macos)}>{t().cta.buttons.macos}</a>
              </div>
              <p class="cta-note"><a href={releaseUrl}>{t().cta.allReleases}</a></p>
            </>
          )}
        </div>
      </section>
      <footer class="footer">
        <div class="wrap footer-inner">
          <span class="f-tag">
            <BrandMark size={20} />
            {t().footer.tagline}
          </span>
          <span>{t().footer.built}</span>
          <a href={REPOSITORY_URL}>GitHub</a>
        </div>
      </footer>
    </>
  );
}
