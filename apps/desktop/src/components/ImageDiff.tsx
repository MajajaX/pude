import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { errorMessage } from "../lib/core";
import { imageMimeType } from "../lib/file-metadata";
import { t } from "../lib/i18n";
import type { ImageDiffVersions, ImageVersion } from "../types";

export type ImageLoader = (version: ImageVersion) => Promise<ArrayBuffer | null>;

/** Shows the image before and after a change side by side. */
export function ImageDiff(props: { path: string; versions: ImageDiffVersions; loadImage: ImageLoader }) {
  return (
    <div class="image-diff">
      <ImageDiffSide
        heading={t("BEFORE")}
        path={props.path}
        version={props.versions.before}
        loadImage={props.loadImage}
        emptyLabel={t("Added in this change")}
      />
      <ImageDiffSide
        heading={t("AFTER")}
        path={props.path}
        version={props.versions.after}
        loadImage={props.loadImage}
        emptyLabel={t("Deleted in this change")}
      />
    </div>
  );
}

type SideState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | {
      kind: "image";
      url: string;
      bytes: number;
      width?: number;
      height?: number;
    };

function ImageDiffSide(props: {
  heading: string;
  path: string;
  version?: ImageVersion;
  loadImage: ImageLoader;
  emptyLabel: string;
}) {
  const [state, setState] = createSignal<SideState>({ kind: "loading" });

  createEffect(() => {
    const version = props.version;
    const path = props.path;
    let cancelled = false;
    let objectUrl: string | undefined;
    onCleanup(() => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
    if (!version) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    props
      .loadImage(version)
      .then((bytes) => {
        if (cancelled) return;
        if (!bytes) {
          setState({ kind: "missing" });
          return;
        }
        const mimeType = imageMimeType(path);
        objectUrl = URL.createObjectURL(new Blob([bytes], mimeType ? { type: mimeType } : {}));
        setState({ kind: "image", url: objectUrl, bytes: bytes.byteLength });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            kind: "error",
            message: errorMessage(error, "Unable to preview this image."),
          });
      });
  });

  const image = () => {
    const current = state();
    return current.kind === "image" ? current : undefined;
  };
  const errorText = () => {
    const current = state();
    return current.kind === "error" ? current.message : undefined;
  };

  return (
    <section class="image-diff-side" aria-label={props.heading}>
      <div class="image-diff-heading">
        <span>{props.heading}</span>
        <Show when={image()}>
          {(current) => (
            <span class="image-diff-details">
              <Show when={current().width}>
                {current().width} × {current().height} ·{" "}
              </Show>
              {formatBytes(current().bytes)}
            </span>
          )}
        </Show>
      </div>
      <div class="image-diff-canvas">
        <Show when={state().kind === "loading"}>
          <p class="image-preview-status" role="status">
            {t("Loading image…")}
          </p>
        </Show>
        <Show when={state().kind === "missing"}>
          <p class="image-preview-status">{props.emptyLabel}</p>
        </Show>
        <Show when={errorText()}>
          {(message) => (
            <p class="image-preview-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={image()}>
          {(current) => (
            <img
              src={current().url}
              alt={props.heading}
              onLoad={(event) =>
                setState({
                  ...current(),
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() =>
                setState({
                  kind: "error",
                  message: t("The image data could not be decoded. Check that the file is valid and supported."),
                })
              }
            />
          )}
        </Show>
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
