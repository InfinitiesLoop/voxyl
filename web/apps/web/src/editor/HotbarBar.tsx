import type { Hotbar } from "./hotbar.ts";
import { useStore } from "./useStore.ts";

/**
 * The hotbar along the bottom: nine semantic slots, the chosen one outlined and named above.
 * A swatch is the semantic's look (its block's colour, or its tint while undecided).
 */
export function HotbarBar({ hotbar }: { hotbar: Hotbar }) {
  const { slots, selected } = useStore(hotbar.state);
  const current = slots[selected];
  return (
    <div className="hotbar">
      <div className="hotbar-name">{current ? current.name : "Empty slot"}</div>
      <div className="hotbar-slots">
        {slots.map((slot, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positions, not items
            key={i}
            type="button"
            className="hotbar-slot"
            aria-pressed={i === selected}
            title={slot ? `${slot.name}${slot.block ? ` · ${slot.block}` : " · undecided"}` : ""}
            onClick={(e) => {
              hotbar.select(i);
              e.currentTarget.blur(); // keys belong to the view, not the button
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
