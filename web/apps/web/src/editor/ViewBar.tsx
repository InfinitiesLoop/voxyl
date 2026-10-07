// The pieces every pane's toolbar is built from, so a 3D and a 2D bar look and behave alike
// and a new view option is one more piece, not new chrome:
//
//   ViewBar      the strip along the pane's top; pressing it focuses the pane
//   KindSwitch   3D or 2D
//   BarMenu      a button that opens a small panel (time of day, layers, camera, ...)
//   ShowMenu     the pane's overlays, as checkboxes, built from view-options.ts
//   BarSpacer    pushes what follows to the right (readouts)
//
// Buttons give the keyboard back to the view after a click, so Space flies rather than
// pressing the button again.

import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { optionsFor, type PaneKind, type ShowId, type ShowState } from "./view-options.ts";

export function ViewBar({ onFocus, children }: { onFocus: () => void; children: ReactNode }) {
  return (
    <header className="view-bar" onPointerDown={onFocus}>
      {children}
    </header>
  );
}

export function BarSpacer() {
  return <span className="view-bar-spacer" />;
}

/** Runs `action`, then hands the keys back to the view. */
export function blurAfter(action: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    action();
    event.currentTarget.blur();
  };
}

export function KindSwitch({
  kind,
  onChange,
}: {
  kind: PaneKind;
  onChange: (kind: PaneKind) => void;
}) {
  return (
    <span className="kind-switch">
      {(["3d", "2d"] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={kind === k}
          title={k === "3d" ? "A 3D view to fly in" : "A flat 2D slice, one layer at a time"}
          onClick={blurAfter(() => onChange(k))}
        >
          {k.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

/**
 * A button that opens a panel under it. Closes on a press outside it, or on Esc.
 */
export function BarMenu({
  label,
  title,
  align = "left",
  children,
}: {
  label: ReactNode;
  title?: string;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="bar-menu" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        title={title}
        onClick={blurAfter(() => setOpen(!open))}
      >
        {label}
        <span className="bar-menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && <div className={`bar-menu-panel ${align}`}>{children}</div>}
    </div>
  );
}

/** The pane's overlays, one checkbox each, from the registry. */
export function ShowMenu({
  kind,
  show,
  onShow,
}: {
  kind: PaneKind;
  show: ShowState;
  onShow: (id: ShowId, on: boolean) => void;
}) {
  const options = optionsFor(kind);
  if (options.length === 0) return null;
  return (
    <BarMenu label="Show" title="Overlays in this view">
      {options.map((option) => (
        <label key={option.id} className="bar-check" title={option.title}>
          <input
            type="checkbox"
            checked={show[option.id]}
            onChange={(e) => {
              onShow(option.id, e.target.checked);
              e.currentTarget.blur();
            }}
          />
          {option.label}
        </label>
      ))}
    </BarMenu>
  );
}
