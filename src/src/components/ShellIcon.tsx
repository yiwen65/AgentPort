type ShellIconProps = {
  className?: string;
  size?: number;
};

/** Canonical terminal mark shared by quick launch and lifecycle states. */
export default function ShellIcon({ className, size = 20 }: ShellIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m5 6 3.5 4L5 14m5.5 0H15"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
