import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import { activeDeviceContext } from "../deviceContext";
import { MarkdownImageSession, imageTransport } from "../markdownImages";

export type TaskRichEditorFormat =
  | "heading"
  | "bold"
  | "italic"
  | "strike"
  | "unordered-list"
  | "task-list"
  | "quote"
  | "code"
  | "link";

export type TaskRichEditorHandle = {
  format: (format: TaskRichEditorFormat) => void;
  insertPendingImage: (alt: string) => string;
  resolvePendingImage: (id: string, url: string, alt: string, previewUrl?: string) => void;
  failPendingImage: (id: string) => void;
  insertImage: (url: string, alt: string, previewUrl?: string) => void;
  focus: () => void;
};

type TaskRichEditorProps = {
  initialValue?: string;
  onChange: (value: string) => void;
  onImageFile: (file: File) => void;
  onNativeImagePaste?: () => void;
  onError?: (message: string) => void;
  placeholder?: string;
};

const IMAGE_URL_PATTERN = /^https:\/\/[^\s]+$/i;
const TRANSPARENT_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export function safeTaskImageUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownInlineToHtml(value: string): string {
  const placeholders: string[] = [];
  const placeholder = (html: string) => {
    const index = placeholders.push(html) - 1;
    return `\uE000${index}\uE001`;
  };
  let source = value.replace(/`([^`\n]+)`/g, (_match, code: string) => placeholder(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/gi, (_match, alt: string, url: string) =>
    safeTaskImageUrl(url) ? placeholder(`<img src="${TRANSPARENT_IMAGE}" alt="${escapeHtml(alt)}" data-markdown-src="${escapeHtml(url)}" data-task-image="true">`) : _match,
  );
  source = source.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/gi, (_match, text: string, url: string) =>
    safeTaskImageUrl(url) ? placeholder(`<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(text)}</a>`) : _match,
  );
  let html = escapeHtml(source);
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return html.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => placeholders[Number(index)] ?? "");
}

function markdownToEditorHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```(?:[^\s`]*)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${markdownInlineToHtml(heading[2])}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${quote.map((item) => markdownInlineToHtml(item)).join("<br>")}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.*)$/);
    const task = line.match(/^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/);
    if (unordered || task) {
      const items: string[] = [];
      const isTaskList = Boolean(task);
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-+*]\s+(.*)$/);
        if (!item) break;
        const taskItem = item[1].match(/^\[([ xX])\]\s+(.*)$/);
        if (isTaskList !== Boolean(taskItem)) break;
        const itemValue = taskItem ? taskItem[2] : item[1];
        const checkbox = taskItem ? `<input type="checkbox" aria-label="Task complete"${taskItem[1].toLowerCase() === "x" ? " checked" : ""}>` : "";
        items.push(`<li>${checkbox}${markdownInlineToHtml(itemValue)}</li>`);
        index += 1;
      }
      blocks.push(`<ul${isTaskList ? " data-task-list=\"true\"" : ""}>${items.join("")}</ul>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!item) break;
        items.push(`<li>${markdownInlineToHtml(item[1])}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length > 0 && (/^\s*(#{1,6})\s+/.test(lines[index]) || /^\s*```/.test(lines[index]) || /^\s*>/.test(lines[index]) || /^\s*[-+*]\s+/.test(lines[index]) || /^\s*\d+[.)]\s+/.test(lines[index]))) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${paragraph.map((item) => markdownInlineToHtml(item)).join("<br>")}</p>`);
  }
  return blocks.join("");
}

function isBlockElement(element: Element): boolean {
  return /^(address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|ul)$/.test(element.tagName.toLowerCase());
}

function safeMarkdownUrl(value: string): string | null {
  return safeTaskImageUrl(value) ? value.trim() : null;
}

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.replace(/\u00a0/g, " ") ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  if (element.dataset.taskImagePending === "true") return "";
  const tag = element.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "img") {
    const url = safeMarkdownUrl(element.getAttribute("data-markdown-src") ?? element.getAttribute("src") ?? "");
    return url ? `![${element.getAttribute("alt") ?? "image"}](${url})` : "";
  }
  if (tag === "input" && element.getAttribute("type") === "checkbox") {
    return `${(element as HTMLInputElement).checked ? "[x]" : "[ ]"} `;
  }
  const content = Array.from(element.childNodes).map(inlineToMarkdown).join("");
  if (tag === "strong" || tag === "b") return content.trim() ? `**${content}**` : "";
  if (tag === "em" || tag === "i") return content.trim() ? `*${content}*` : "";
  if (tag === "del" || tag === "s") return content.trim() ? `~~${content}~~` : "";
  if (tag === "code") return content.trim() ? `\`${content}\`` : "";
  if (tag === "a") {
    const url = safeMarkdownUrl(element.getAttribute("href") ?? "");
    return url ? `[${content}](${url})` : content;
  }
  return content;
}

function listItemToMarkdown(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => !(node.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/i.test((node as Element).tagName)))
    .map(inlineToMarkdown)
    .join("")
    .trim();
}

function blockToMarkdown(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    return `${"#".repeat(Number(tag.slice(1)))} ${inlineToMarkdown(element).trim()}\n\n`;
  }
  if (tag === "p") return `${inlineToMarkdown(element).trimEnd()}\n\n`;
  if (tag === "pre") {
    const code = element.textContent?.replace(/\n$/, "") ?? "";
    return `\`\`\`\n${code}\n\`\`\`\n\n`;
  }
  if (tag === "blockquote") {
    const content = Array.from(element.childNodes).map((node) => node.nodeType === Node.ELEMENT_NODE && isBlockElement(node as Element) ? blockToMarkdown(node as Element) : inlineToMarkdown(node)).join("").trim();
    return `${content.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
  }
  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "li");
    return `${items.map((item, index) => {
      const content = listItemToMarkdown(item);
      const checkbox = item.querySelector(":scope > input[type=checkbox]");
      const marker = ordered ? `${index + 1}.` : checkbox ? (checkbox as HTMLInputElement).checked ? "- [x]" : "- [ ]" : "-";
      return `${marker} ${content.replace(/^\[[ xX]\]\s*/, "")}`;
    }).join("\n")}\n\n`;
  }
  if (tag === "div") return `${inlineToMarkdown(element).trimEnd()}\n\n`;
  return Array.from(element.childNodes).map((node) => node.nodeType === Node.ELEMENT_NODE && isBlockElement(node as Element) ? blockToMarkdown(node as Element) : inlineToMarkdown(node)).join("");
}

function editorHtmlToMarkdown(root: HTMLElement): string {
  const output = Array.from(root.childNodes).map((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && isBlockElement(node as Element)) return blockToMarkdown(node as Element);
    return inlineToMarkdown(node);
  }).join("");
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

function selectionInside(root: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !root.contains(selection.anchorNode)) return null;
  return selection.getRangeAt(0);
}

function setCaretAfter(node: Node, root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  root.focus();
}

export const TaskRichEditor = forwardRef<TaskRichEditorHandle, TaskRichEditorProps>(function TaskRichEditor({
  initialValue = "",
  onChange,
  onImageFile,
  onNativeImagePaste,
  onError,
  placeholder = "What's going on?",
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const savedSelectionRef = useRef<Range | null>(null);
  const imageSessionRef = useRef<MarkdownImageSession | null>(null);
  const retainedImageSourcesRef = useRef<Map<string, number>>(new Map());
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const imageSequenceRef = useRef(0);

  const updateEmptyState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const hasImage = Boolean(editor.querySelector("img"));
    editor.dataset.empty = String(!editor.textContent?.trim() && !hasImage);
  }, []);

  const saveSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = selectionInside(editor);
    if (range) savedSelectionRef.current = range.cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    const range = savedSelectionRef.current;
    if (!editor || !range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const emitChange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    updateEmptyState();
      onChange(editorHtmlToMarkdown(editor));
  }, [onChange, updateEmptyState]);

  const insertHtml = useCallback((html: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    editor.focus();
    const range = selectionInside(editor) ?? (() => {
      const next = document.createRange();
      next.selectNodeContents(editor);
      next.collapse(false);
      return next;
    })();
    range.deleteContents();
    const fragment = range.createContextualFragment(html);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) setCaretAfter(last, editor);
    saveSelection();
    emitChange();
  }, [emitChange, restoreSelection, saveSelection]);

  const resolveEditorImages = useCallback(async () => {
    const editor = editorRef.current;
    const session = imageSessionRef.current;
    if (!editor || !session) return;
    const images = Array.from(editor.querySelectorAll<HTMLImageElement>("img[data-markdown-src]"));
    const currentLocalPreviewUrls = new Set(images.map((image) => image.dataset.localPreviewSrc).filter((url): url is string => Boolean(url)));
    for (const url of previewUrlsRef.current) {
      if (!currentLocalPreviewUrls.has(url)) {
        URL.revokeObjectURL(url);
        previewUrlsRef.current.delete(url);
      }
    }
    const currentCounts = new Map<string, number>();
    for (const image of images) {
      const source = image.dataset.markdownSrc;
      if (source) currentCounts.set(source, (currentCounts.get(source) ?? 0) + 1);
    }
    for (const [source, previousCount] of retainedImageSourcesRef.current) {
      const currentCount = currentCounts.get(source) ?? 0;
      if (currentCount < previousCount) {
        for (let index = currentCount; index < previousCount; index += 1) session.release(source);
      }
    }
    for (const [source, currentCount] of currentCounts) {
      const previousCount = retainedImageSourcesRef.current.get(source) ?? 0;
      for (let index = previousCount; index < currentCount; index += 1) session.retain(source);
    }
    retainedImageSourcesRef.current = currentCounts;
    await Promise.all(images.map(async (image) => {
      const source = image.dataset.markdownSrc;
      if (!source) return;
      await session.load(source);
      if (!editor.isConnected) return;
      const state = session.snapshot(source);
      if (state.status === "ready") {
        image.src = state.url;
        image.dataset.previewSrc = state.url;
        delete image.dataset.imageError;
      } else if (state.status === "error") {
        image.src = TRANSPARENT_IMAGE;
        image.dataset.imageError = state.error ?? "Image could not be loaded";
        onError?.(state.error ?? "Image could not be loaded");
      }
    }));
  }, [onError]);

  const insertPendingImage = useCallback((alt: string) => {
    const imageId = `task-image-${Date.now()}-${imageSequenceRef.current++}`;
    const safeAlt = alt.trim() || "image";
    insertHtml(`<span class="task-center-rich-editor-pending-image" data-task-image-pending="true" data-task-image-id="${imageId}" contenteditable="false">Uploading ${escapeHtml(safeAlt)}…</span>`);
    return imageId;
  }, [insertHtml]);

  const resolvePendingImage = useCallback((id: string, url: string, alt: string, previewUrl?: string) => {
    const normalized = url.trim();
    const editor = editorRef.current;
    const pending = editor?.querySelector<HTMLElement>(`[data-task-image-id="${id}"]`);
    if (!editor || !pending || !safeTaskImageUrl(normalized) || !IMAGE_URL_PATTERN.test(normalized)) return;
    const image = document.createElement("img");
    image.alt = alt.trim() || "image";
    image.dataset.markdownSrc = normalized;
    image.dataset.taskImage = "true";
    image.dataset.taskImageId = id;
    const safePreview = previewUrl && (/^blob:/i.test(previewUrl) || /^data:image\//i.test(previewUrl)) ? previewUrl : TRANSPARENT_IMAGE;
    image.src = safePreview;
    if (previewUrl && safePreview === previewUrl) {
      image.dataset.localPreviewSrc = previewUrl;
      previewUrlsRef.current.add(previewUrl);
    }
    pending.replaceWith(image);
    emitChange();
    void resolveEditorImages();
  }, [emitChange, resolveEditorImages]);

  const failPendingImage = useCallback((id: string) => {
    const pending = editorRef.current?.querySelector<HTMLElement>(`[data-task-image-id="${id}"]`);
    if (!pending) return;
    pending.remove();
    emitChange();
  }, [emitChange]);

  const insertImage = useCallback((url: string, alt: string, previewUrl?: string) => {
    const normalized = url.trim();
    if (!safeTaskImageUrl(normalized) || !IMAGE_URL_PATTERN.test(normalized)) {
      onError?.("Use an anonymous HTTPS image URL.");
      return;
    }
    const safeAlt = alt.trim() || "image";
    const imageId = `task-image-${Date.now()}-${imageSequenceRef.current++}`;
    const safePreview = previewUrl && (/^blob:/i.test(previewUrl) || /^data:image\//i.test(previewUrl)) ? previewUrl : TRANSPARENT_IMAGE;
    const previewAttribute = previewUrl && safePreview === previewUrl ? ` data-local-preview-src="${escapeHtml(previewUrl)}"` : "";
    insertHtml(`<img src="${escapeHtml(safePreview)}" alt="${escapeHtml(safeAlt)}" data-markdown-src="${escapeHtml(normalized)}" data-task-image="true" data-task-image-id="${imageId}"${previewAttribute}>`);
    const image = editorRef.current?.querySelector<HTMLImageElement>(`img[data-task-image-id="${imageId}"]`);
    if (previewUrl && image && safePreview === previewUrl) previewUrlsRef.current.add(previewUrl);
    void resolveEditorImages();
  }, [insertHtml, onError, resolveEditorImages]);

  const format = useCallback((kind: TaskRichEditorFormat) => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    editor.focus();
    if (kind === "heading") document.execCommand("formatBlock", false, "<h1>");
    else if (kind === "unordered-list") document.execCommand("insertUnorderedList");
    else if (kind === "task-list") insertHtml("<ul data-task-list=\"true\"><li><input type=\"checkbox\" aria-label=\"Task complete\">Task</li></ul>");
    else if (kind === "quote") document.execCommand("formatBlock", false, "<blockquote>");
    else if (kind === "code") document.execCommand("formatBlock", false, "<pre>");
    else if (kind === "link") {
      const url = window.prompt("Link URL", "https://");
      if (!url) return;
      if (!safeTaskImageUrl(url)) {
        onError?.("Use an anonymous HTTPS link.");
        return;
      }
      if (window.getSelection()?.isCollapsed) document.execCommand("insertText", false, "link text");
      document.execCommand("createLink", false, url.trim());
    } else {
      document.execCommand(kind === "strike" ? "strikeThrough" : kind);
    }
    emitChange();
  }, [emitChange, insertHtml, onError, restoreSelection]);

  useImperativeHandle(ref, () => ({
    format,
    insertPendingImage,
    resolvePendingImage,
    failPendingImage,
    insertImage,
    focus: () => editorRef.current?.focus(),
  }), [failPendingImage, format, insertImage, insertPendingImage, resolvePendingImage]);

  useEffect(() => {
    const device = activeDeviceContext();
    const session = new MarkdownImageSession(
      { path: "task-composer.md", rootPath: "/", device },
      imageTransport(device),
    );
    imageSessionRef.current = session;
    void resolveEditorImages();
    return () => {
      session.dispose();
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
      imageSessionRef.current = null;
    };
  }, [resolveEditorImages]);

  useEffect(() => {
    if (initializedRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = markdownToEditorHtml(initialValue);
    updateEmptyState();
    initializedRef.current = true;
    void resolveEditorImages();
  }, [initialValue, resolveEditorImages, updateEmptyState]);

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const itemFile = Array.from(event.clipboardData.items)
      .map((item) => item.kind === "file" ? item.getAsFile() : null)
      .find((file): file is File => Boolean(file?.type.startsWith("image/")));
    const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")) ?? itemFile;
    if (file) {
      event.preventDefault();
      onImageFile(file);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) {
      event.preventDefault();
      onNativeImagePaste?.();
      return;
    }
    event.preventDefault();
    insertHtml(markdownToEditorHtml(text));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/"));
    if (file) {
      onImageFile(file);
      return;
    }
    const text = event.dataTransfer.getData("text/plain");
    if (text) insertHtml(markdownToEditorHtml(text));
  };

  return (
    <div
      ref={editorRef}
      className="task-center-rich-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Task description"
      data-empty="true"
      data-placeholder={placeholder}
      spellCheck
      onClick={(event) => {
        if ((event.target as Element | null)?.closest("a")) event.preventDefault();
      }}
      onInput={() => { emitChange(); void resolveEditorImages(); }}
      onChange={() => { emitChange(); void resolveEditorImages(); }}
      onBlur={saveSelection}
      onKeyUp={saveSelection}
      onMouseUp={saveSelection}
      onSelect={saveSelection}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    />
  );
});
