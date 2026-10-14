import DOMPurify from "dompurify";
import { staticImageStyles } from "./svgImageStyles";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, type MarkdownImageData } from "../../protocol/markdownImageClient";
export interface ImageAsset { url: string; width: number; height: number; bytes: number }

export function sanitizeImageSvg(source: string, width?: number, height?: number): string {
  const original = new DOMParser().parseFromString(source, "image/svg+xml");
  if (original.querySelector("parsererror") || original.documentElement.localName !== "svg" || /<!DOCTYPE|<!ENTITY/i.test(source)) throw { code: "invalid_image" };
  staticImageStyles(original);
  const clean = DOMPurify.sanitize(new XMLSerializer().serializeToString(original.documentElement), { USE_PROFILES: { svg: true }, ADD_TAGS: ["use"], FORBID_TAGS: ["script", "foreignObject", "image", "a", "animate", "animateMotion", "animateTransform", "set", "filter", "style"], FORBID_ATTR: ["target", "style"] });
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (document.querySelector("parsererror") || root.localName !== "svg") throw { code: "invalid_image" };
  const unsafeCss = (value: string) => /\\|@/i.test(value) || [...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(match => !/^["']?#[\w:.-]+["']?$/.test(match[1].trim()));
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.localName === "style" && unsafeCss(element.textContent ?? "")) { element.remove(); continue; }
    for (const attribute of [...element.attributes]) {
      if ((["href", "xlink:href"].includes(attribute.name) && !/^#[\w:.-]+$/.test(attribute.value)) || attribute.name === "filter" || unsafeCss(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  const elements = [root, ...root.querySelectorAll("*")];
  if (elements.length > 20_000) throw { code: "invalid_image" };
  const ids = new Map<string, Element>();
  for (const element of elements) { const id = element.getAttribute("id"); if (id && !ids.has(id)) ids.set(id, element); }
  const memo = new Map<Element, number>(); const heights = new Map<Element, number>(); const visiting = new Set<Element>();
  const cost = (element: Element, depth: number): number => {
    if (depth > 128 || visiting.has(element)) throw { code: "invalid_image" };
    if (memo.has(element)) { if (depth + heights.get(element)! > 128) throw { code: "invalid_image" }; return memo.get(element)!; }
    visiting.add(element); let total = 1; let height = 0;
    for (const child of element.children) { total += cost(child, depth + 1); height = Math.max(height, 1 + heights.get(child)!); if (total > 20_000) throw { code: "invalid_image" }; }
    if (element.localName === "use") {
      const target = ids.get((element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "").slice(1));
      if (target) { total += cost(target, depth + 1); height = Math.max(height, 1 + heights.get(target)!); }
    }
    if (total > 20_000 || depth + height > 128) throw { code: "invalid_image" };
    visiting.delete(element); memo.set(element, total); heights.set(element, height); return total;
  };
  cost(root, 0);
  if (width && height) {
    root.setAttribute("width", String(width)); root.setAttribute("height", String(height));
    root.setAttribute("style", `${root.getAttribute("style") ?? ""};width:${width}px!important;height:${height}px!important;overflow:hidden!important`);
  }
  return new XMLSerializer().serializeToString(root);
}

export function createImageAsset(data: MarkdownImageData): ImageAsset {
  if (!Number.isSafeInteger(data.width) || !Number.isSafeInteger(data.height) || data.width < 1 || data.height < 1 || data.width * data.height > MAX_IMAGE_PIXELS) throw { code: "image_dimensions" };
  if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(data.mime) || data.contentBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw { code: "unsupported_image" };
  const binary = atob(data.contentBase64);
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) throw { code: "image_too_large" };
  // atob returns byte-valued code units. Fill the final buffer directly:
  // Uint8Array.from(string) first walks the string iterator and materializes
  // an intermediate element list, amplifying memory for multi-MiB images.
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const blob = data.mime === "image/svg+xml" ? new Blob([sanitizeImageSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes), data.width, data.height)], { type: data.mime }) : new Blob([bytes], { type: data.mime });
  if (blob.size > MAX_IMAGE_BYTES) throw { code: "image_too_large" };
  return { url: URL.createObjectURL(blob), width: data.width, height: data.height, bytes: blob.size };
}
