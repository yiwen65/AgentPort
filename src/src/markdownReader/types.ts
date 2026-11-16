import type { Root as HastRoot } from "hast";
import type { MarkdownImageSession } from "../markdownImages";

export type DocReadingTheme = "terminal" | "paper" | "night";

export type AlertType = "note" | "tip" | "important" | "warning" | "caution";

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  line: number;
}

export interface MarkdownLinkContext {
  path: string;
  rootPath: string;
}

export interface MarkdownImageInfo {
  index: number;
  source: string;
  alt: string;
  title: string | null;
  line: number;
}

export interface DocumentLinkTargetInfo {
  path: string;
  line: number | null;
  anchor: string | null;
}

export interface MarkdownViewProps {
  source: string;
  sourceLocations?: boolean;
  imageSession?: MarkdownImageSession;
  linkContext?: MarkdownLinkContext;
  onLinkClick?: (href: string) => void;
  onOpenDocument?: (target: DocumentLinkTargetInfo) => void;
  onOutlineChange?: (items: OutlineItem[]) => void;
  onCopyText?: (text: string) => Promise<boolean> | void;
  onCopyHeadingLink?: (text: string, id: string) => void;
  onNotice?: (message: string) => void;
  readingTheme?: DocReadingTheme;
}

export interface ParsedMarkdown {
  tree: HastRoot | null;
  outline: OutlineItem[];
  images: MarkdownImageInfo[];
  sourceLines: string[];
}
