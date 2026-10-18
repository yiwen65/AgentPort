import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MarkdownImageClient } from "../../protocol/markdownImageClient";
import { createImageAsset, type ImageAsset } from "./markdownImageAssets";
import { ImageViewport } from "./ImageViewport";
import "./markdown-images.css";

export const isImageFile = (path: string) => /\.(?:png|jpe?g|webp|gif|svg)$/i.test(path);
export type ImageBackground = "checker" | "light" | "dark";

/** An opened file owns one asset, not Markdown's reading-lifetime cache. */
export function SessionImage({ path, client, controlsVisible, background }: {
  path: string; client: MarkdownImageClient; controlsVisible: boolean; background: ImageBackground;
}) {
  const { t } = useTranslation();
  const [asset, setAsset] = useState<ImageAsset>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let owned: ImageAsset | undefined;
    setAsset(undefined); setError(undefined);
    void client.local(path, { signal: controller.signal, animationLimits: true }).then(data => {
      if (controller.signal.aborted) return;
      owned = createImageAsset(data);
      setAsset(owned);
    }).catch(value => { if (!controller.signal.aborted) setError(value); });
    return () => { controller.abort(); if (owned) URL.revokeObjectURL(owned.url); };
  }, [path, client, attempt]);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = code === "animation_limit" ? t("images.animationLimit")
    : ["image_too_large", "image_dimensions", "file_too_large", "byte_limit", "pixel_limit"].includes(code) ? t("images.tooLarge")
    : ["invalid_image", "unsupported_image", "unsupported_format", "unsafe_svg", "mime_mismatch"].includes(code) ? t("images.unsupported")
    : ["unknown_method", "method_not_found", "capability_disabled", "-32601"].includes(code) ? t("files.upgradeRequired")
    : ["outside_root", "path_not_found", "permission_denied", "invalid_path", "session_not_found"].includes(code) ? t(`files.errors.${code}`)
    : t("images.failed");
  return <div className="file-image-content" data-image-background={background} data-no-page-swipe="true"
    onTouchStart={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
    {error ? <div className="files-error" role="alert"><p>{message}</p><button type="button" onClick={() => setAttempt(old => old + 1)}>{t("images.retry")}</button></div>
      : asset ? <ImageViewport key={asset.url} asset={asset} alt={path.split("/").pop() || path} controlsVisible={controlsVisible} onError={() => setError({ code: "invalid_image" })} />
      : <p className="files-note" role="status">{t("images.loading")}</p>}
  </div>;
}
