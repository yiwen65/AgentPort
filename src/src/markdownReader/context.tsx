import { createContext, useContext } from "react";
import type { MarkdownImageSession } from "../markdownImages";
import type {
  AlertType,
  DocReadingTheme,
  MarkdownLinkContext,
  MarkdownViewProps,
} from "./types";

export interface MarkdownReaderLabels {
  alert: Record<AlertType, string>;
  copyHeadingLink: string;
  linkOutsideRoot: string;
}

export interface MarkdownReaderContextValue {
  sourceLocations: boolean;
  sourceLines: string[];
  linkContext?: MarkdownLinkContext;
  imageSession?: MarkdownImageSession;
  readingTheme: DocReadingTheme;
  labels: MarkdownReaderLabels;
  onCopyText?: MarkdownViewProps["onCopyText"];
  onCopyHeadingLink?: MarkdownViewProps["onCopyHeadingLink"];
  onOpenDocument?: MarkdownViewProps["onOpenDocument"];
}

const EMPTY_CONTEXT: MarkdownReaderContextValue = {
  sourceLocations: false,
  sourceLines: [],
  readingTheme: "terminal",
  labels: {
    alert: { note: "", tip: "", important: "", warning: "", caution: "" },
    copyHeadingLink: "",
    linkOutsideRoot: "",
  },
};

export const MarkdownReaderContext = createContext<MarkdownReaderContextValue>(EMPTY_CONTEXT);

export function useMarkdownReader(): MarkdownReaderContextValue {
  return useContext(MarkdownReaderContext) ?? EMPTY_CONTEXT;
}
