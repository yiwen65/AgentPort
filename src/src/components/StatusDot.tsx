// Status dot with evidence tooltip (PRD 3.4 states + 4.3 hover detail:
// source · confidence · time · evidence).

import { formatDateTime, confidenceZh, sourceZh, stateZh, precisionZh } from "../format";
import { getRuntime } from "../store";
import type { SessionView } from "../types";

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

export function dotTipFor(ses: SessionView): string {
  const rt = getRuntime(ses.id);
  if (ses.lifecycle === "creating") return "创建中：正在连接 Session Host";
  if (ses.lifecycle === "interrupted") {
    return `已中断，可恢复\n恢复精度：${precisionZh(ses.resumePrecision)}`;
  }
  if (ses.lifecycle === "exited") {
    const code = rt.exit?.code;
    return code !== undefined && code !== null ? `已退出（退出码 ${code}）` : "已退出";
  }
  if (ses.lifecycle === "stopped") return "已停止";
  const ev = rt.status ?? ses.status;
  if (!ev) return "状态未知：尚未收到状态事件";
  const lines = [
    `${stateZh(ev.state)}`,
    `来源：${sourceZh(ev.source)} · ${confidenceZh(ev.confidence)}`,
    `时间：${formatDateTime(ev.occurredAt)}`,
  ];
  if (ev.evidence) lines.push(`证据：${ev.evidence}`);
  if (ev.confidence !== "high") lines.push("启发式判断，状态可能不精确");
  return lines.join("\n");
}

export default function StatusDot({ session }: { session: SessionView }) {
  const cls = dotClassFor(session);
  const tip = dotTipFor(session);
  const label = tip.split("\n")[0];
  return (
    <span
      className={`dot ${cls}`}
      data-tip={tip}
      role="img"
      aria-label={`状态：${label}`}
      tabIndex={0}
    />
  );
}
