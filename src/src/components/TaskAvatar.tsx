import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

type TaskAvatarSize = "xs" | "sm" | "md" | "lg";

type TaskAvatarProps = {
  name: string;
  avatarUrl?: string | null;
  size?: TaskAvatarSize;
  className?: string;
  decorative?: boolean;
};

function safeAvatarUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function avatarHue(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}

export function TaskAvatar({
  name,
  avatarUrl,
  size = "sm",
  className = "",
  decorative = false,
}: TaskAvatarProps) {
  const normalizedUrl = safeAvatarUrl(avatarUrl);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [normalizedUrl]);
  const label = name.trim() || "Unknown member";
  const classes = ["task-avatar", `task-avatar-${size}`, className].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      style={{ "--task-avatar-hue": avatarHue(label) } as CSSProperties}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : label}
      title={label}
    >
      {normalizedUrl && !imageFailed ? (
        <img
          src={normalizedUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : <span aria-hidden="true">{initials(label)}</span>}
    </span>
  );
}

export type { TaskAvatarProps, TaskAvatarSize };
