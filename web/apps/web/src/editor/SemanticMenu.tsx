import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { PaletteEntryDialog } from "./PaletteEntry.tsx";

/** Where a right-click asked to edit or delete a semantic. */
export interface SemanticMenuTarget {
  x: number;
  y: number;
  palette: PaletteInfo;
  semantic: SemanticInfo;
}

/** Keeps the menu on screen, opening upward when the click is near the bottom. */
export function menuAnchor(clientX: number, clientY: number): { x: number; y: number } {
  const width = 200;
  const height = 88;
  const y = clientY + height > window.innerHeight ? clientY - height : clientY;
  return {
    x: Math.max(8, Math.min(clientX, window.innerWidth - width)),
    y: Math.max(8, y),
  };
}

/**
 * Edit or Delete for one semantic, the same menu the inventory grid and a hotbar slot use.
 * Edit opens the entry dialog. A linked palette explains itself instead of offering either.
 */
export function SemanticMenu({
  engine,
  target,
  onClose,
}: {
  engine: Engine;
  target: SemanticMenuTarget | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    palette: PaletteInfo;
    semantic: SemanticInfo;
  } | null>(null);

  useEffect(() => {
    if (target) setNotice(null);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const down = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && menuRef.current?.contains(node)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [target, onClose]);

  const remove = () => {
    if (!target || typeof target.semantic.ref !== "number") return;
    void engine.world.request({ type: "removeSemantic", semantic: target.semantic.ref }).then(
      () => onClose(),
      (caught: unknown) => setNotice(caught instanceof Error ? caught.message : String(caught)),
    );
  };

  return (
    <>
      {target &&
        createPortal(
          <div
            ref={menuRef}
            className="entry-menu"
            role="menu"
            style={{ left: target.x, top: target.y }}
          >
            {target.palette.linked ? (
              <p>{target.palette.name} is a shared palette: change it from Home.</p>
            ) : notice ? (
              <p>{notice}</p>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setEditing({ palette: target.palette, semantic: target.semantic });
                    onClose();
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={typeof target.semantic.ref !== "number"}
                  title={
                    typeof target.semantic.ref !== "number"
                      ? "It comes from a parent palette. Edit it there."
                      : "Remove it. Refused while cells use it."
                  }
                  onClick={remove}
                >
                  Delete
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {editing && (
        <PaletteEntryDialog
          engine={engine}
          palette={editing.palette}
          semantic={editing.semantic}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
