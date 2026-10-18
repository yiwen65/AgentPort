import { Modal } from "../../components/Modal";
import type { ImageAsset } from "./markdownImageAssets";
import { ImageViewport } from "./ImageViewport";

export function MarkdownImageViewer({ asset, alt, onClose }: { asset: ImageAsset; alt: string; onClose: () => void }) {
  return <Modal title={alt} onClose={onClose} className="markdown-image-viewer">
    <ImageViewport asset={asset} alt={alt} />
  </Modal>;
}
