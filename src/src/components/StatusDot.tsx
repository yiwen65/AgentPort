// Status dot with a user-facing state/time tooltip. Technical evidence stays
// in diagnostics and timeline surfaces rather than the normal session UI.

import { formatDateTime, precisionLabel, stateLabel } from "../format";
import { i18n } from "../i18n";
import { getRuntime } from "../store";
import type { SessionView } from "../types";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

export function dotClassFor(ses: SessionView): string {
  switch (ses.lifecycle) {
    case "creating":
      return "creating";
    case "interrupted":
      return "interrupted";
    case "exited":
      return "exited";
    case "stopped":
      return "stopped";
    case "running":
      return ses.status?.state ?? "unknown";
  }
}

function translatedDotTipFor(ses: SessionView, t: TFunction<"session">): string {
  const rt = getRuntime(ses.id);
  if (ses.lifecycle === "creating") return t("ui.status.connectingHost");
  if (ses.lifecycle === "interrupted") {
    return t("ui.status.interruptedResumable", {
      precision: precisionLabel(ses.resumePrecision),
    });
  }
  if (ses.lifecycle === "exited") {
    const code = rt.exit?.code;
    return code !== undefined && code !== null
      ? t("ui.status.exitedWithCode", { code })
      : t("ui.status.exited");
  }
  if (ses.lifecycle === "stopped") return t("ui.status.stopped");
  const ev = rt.status ?? ses.status;
  if (!ev) return t("ui.status.unknownNoEvent");
  const lines = [
    stateLabel(ev.state),
    t("ui.status.time", { time: formatDateTime(ev.occurredAt) }),
  ];
  return lines.join("\n");
}

export function dotTipFor(ses: SessionView): string {
  return translatedDotTipFor(ses, i18n.getFixedT(null, "session"));
}

export default function StatusDot({ session }: { session: SessionView }) {
  const { t } = useTranslation("session");
  const cls = dotClassFor(session);
  const tip = translatedDotTipFor(session, t);
  const label = tip.split("\n")[0];
  return (
    <span
      className={`dot ${cls}`}
      data-tip={tip}
      role="img"
      aria-label={t("ui.status.ariaLabel", { status: label })}
      tabIndex={0}
    />
  );
}
