import { type ReactNode, useState } from "react";
import { readSemanticDrag, SEMANTIC_DRAG } from "./drag.ts";
import type { Hotbar } from "./hotbar.ts";
import { useStore } from "./useStore.ts";

/**
 * The hotbar along the bottom: nine semantic slots, the chosen one outlined and named above.
 * A swatch is the semantic's look (its block's colour, or its tint while undecided).
 * `aside` sits to the left of the slots without moving them off centre (the tool badge).
 */
export function HotbarBar({ hotbar, aside }: { hotbar: Hotbar; aside?: ReactNode }) {
  const { slots, selected } = useStore(hotbar.state);
  const [over, setOver] = useState<number | null>(null);
  const current = slots[selected];
  return (
    <div className="hotbar">
      <div className="hotbar-name">{current ? current.name : "Empty slot"}</div>
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
            <span
              className={slot?.glow ? "swatch glow" : "swatch"}
              style={slot ? { background: slot.color } : undefined}
            />
            <span className="hotbar-key">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
