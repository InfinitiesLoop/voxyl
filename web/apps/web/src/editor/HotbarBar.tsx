import { type ReactNode, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import { readSemanticDrag, SEMANTIC_DRAG } from "./drag.ts";
import type { Hotbar } from "./hotbar.ts";
import { BakedIcon } from "./icons.tsx";
import { menuAnchor, SemanticMenu, type SemanticMenuTarget } from "./SemanticMenu.tsx";
import { useStore } from "./useStore.ts";

/**
 * The hotbar along the bottom: nine semantic slots, the chosen one outlined, each named
 * under its block. A picture is the baked block, or the semantic's colour while undecided.
 * Right-click a filled slot for the same Edit or Delete the inventory offers.
 * `aside` sits to the left of the slots without moving them off centre (the tool badge).
 */
export function HotbarBar({
  hotbar,
  engine,
  aside,
}: {
  hotbar: Hotbar;
  engine: Engine;
  aside?: ReactNode;
}) {
  const { slots, selected } = useStore(hotbar.state);
  const palettes = useStore(engine.palettes);
  const [over, setOver] = useState<number | null>(null);
  const [menu, setMenu] = useState<SemanticMenuTarget | null>(null);
  return (
    <div className="hotbar">
      <div className="hotbar-slots">
        {aside && <div className="hotbar-aside">{aside}</div>}
        {slots.map((slot, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positions, not items
            key={i}
            type="button"
            className={over === i ? "hotbar-slot over" : "hotbar-slot"}
            aria-pressed={i === selected}
            title={
              slot
                ? `${slot.name}${slot.block ? ` · ${slot.block}` : " · undecided"}`
                : "Drop a semantic here"
            }
            onClick={(e) => {
              hotbar.select(i);
              e.currentTarget.blur(); // keys belong to the view, not the button
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              hotbar.select(i);
              e.currentTarget.blur();
              if (!slot) return;
              const palette = palettes.find((item) => item.id === slot.palette);
              if (!palette) return;
              const at = menuAnchor(e.clientX, e.clientY);
              setMenu({ ...at, palette, semantic: slot });
            }}
            onDragOver={(e) => {
              if (![...e.dataTransfer.types].includes(SEMANTIC_DRAG)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(i);
            }}
            onDragLeave={() => setOver((current) => (current === i ? null : current))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const info = readSemanticDrag(e.dataTransfer);
              if (info) hotbar.assign(i, info);
            }}
          >
            {slot ? (
              <BakedIcon
                engine={engine}
                block={slot.block}
                color={slot.color}
                className={slot.glow ? "hotbar-icon glow" : "hotbar-icon"}
              />
            ) : (
              <span className="swatch" />
            )}
            {slot && <span className="hotbar-slot-name">{slot.name}</span>}
            <span className="hotbar-key">{i + 1}</span>
          </button>
        ))}
      </div>
      <SemanticMenu engine={engine} target={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
