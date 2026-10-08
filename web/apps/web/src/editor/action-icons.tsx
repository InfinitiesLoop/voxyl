import type { ReactNode } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
};

/** Small pictures for the things you do to a selection, in the selection panel's toolbar. */
export type ActionIconId = "cut" | "copy" | "prefab" | "schematic";

const ICONS: Record<ActionIconId, ReactNode> = {
  cut: (
    <>
      <circle {...stroke} cx="6.5" cy="17.5" r="2.7" />
      <circle {...stroke} cx="17.5" cy="17.5" r="2.7" />
      <path {...stroke} d="M8.3 15.4 17 3.8M15.7 15.4 7 3.8" />
    </>
  ),
  copy: (
    <>
      <rect {...stroke} x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path {...stroke} d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  prefab: (
    <>
      <path {...stroke} d="M10.5 3.5 17 7.2v7.6l-6.5 3.7L4 14.8V7.2Z" />
      <path {...stroke} d="M4 7.2l6.5 3.7 6.5-3.7M10.5 10.9v7.6" />
      <path {...stroke} d="M19 15.5v5M16.5 18h5" />
    </>
  ),
  schematic: (
    <>
      <path {...stroke} d="M6 3h8l4 4v14H6Z" />
      <path {...stroke} d="M14 3v4h4" />
      <path {...stroke} d="M12 10.5v6M9.5 14.2 12 16.7l2.5-2.5" />
    </>
  ),
};

export function ActionIcon({ id }: { id: ActionIconId }) {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden>
      {ICONS[id]}
    </svg>
  );
}
