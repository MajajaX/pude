import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { readWorkspaceImage } from "../lib/bridge";

function imageMimeType(path: string): string | undefined {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    default: return undefined;
  }
}

export function ImagePreview(props: { path: string; workspace: string }) {
  const [imageUrl, setImageUrl] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);

  createEffect(() => {
    const path = props.path;
    const workspace = props.workspace;
    let cancelled = false;
    let objectUrl: string | undefined;
    setImageUrl(undefined);
    setError(undefined);
    setLoading(true);

    void readWorkspaceImage(path, workspace).then((bytes) => {
      if (cancelled) return;
      const mimeType = imageMimeType(path);
      objectUrl = URL.createObjectURL(new Blob([bytes], mimeType ? { type: mimeType } : {}));
      setImageUrl(objectUrl);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to preview this image.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    onCleanup(() => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  });

  return (
    <div class="image-preview" aria-label={`Image preview: ${props.path.split(/[\\/]/).at(-1) ?? props.path}`}>
      <Show when={loading()}><p class="image-preview-status" role="status">Loading image…</p></Show>
      <Show when={error()}>{(message) => <p class="image-preview-error" role="alert">{message()}</p>}</Show>
      <Show when={imageUrl()}>{(url) => <img src={url()} alt={props.path.split(/[\\/]/).at(-1) ?? "Image preview"} onError={(event) => {
        const failedUrl = event.currentTarget.src;
        if (failedUrl !== imageUrl()) return;
        setImageUrl(undefined);
        URL.revokeObjectURL(failedUrl);
        setError("The image data could not be decoded. Check that the file is valid and supported.");
      }} />}</Show>
    </div>
  );
}
