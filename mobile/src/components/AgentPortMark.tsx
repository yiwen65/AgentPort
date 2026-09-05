import { useId } from "react";

/** Center mark only: open orbit and satellite; CSS provides two contrast-tuned variants. */
export function AgentPortMark() {
  const gradient = useId();
  return <svg className="agentport-mark" aria-hidden="true" focusable="false" viewBox="0 0 48 48" fill="none">
    <defs><linearGradient id={gradient} x1="9" y1="5" x2="36" y2="43" gradientUnits="userSpaceOnUse">
      <stop className="mark-cyan" /><stop offset=".58" className="mark-blue" /><stop offset="1" className="mark-violet" />
    </linearGradient></defs>
    <path d="M40.1 14.9a18.5 18.5 0 1 0 0 18.2" stroke={`url(#${gradient})`} strokeWidth="4.5" strokeLinecap="round" />
    <circle className="mark-satellite" cx="42" cy="24" r="3.6" />
  </svg>;
}
