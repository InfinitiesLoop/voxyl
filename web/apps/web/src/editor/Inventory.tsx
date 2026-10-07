import { useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import { HotbarBar } from "./HotbarBar.tsx";
import { HOTBAR_SLOTS } from "./hotbar.ts";
import { useStore } from "./useStore.ts";

/**
 * Loads the hotbar. Palettes on the left, the chosen palette's semantics as swatches,
 * and the same hotbar as the workspace. Clicking a semantic fills the chosen slot and
 * moves to the next. Editing a look stays in the palette drawer; this is only for picking.
 */
export function Inventory({ engine }: { engine: Engine }) {
  const open = useStore(engine.inventoryOpen);
  const palettes = useStore(engine.palettes);
  const [paletteId, setPaletteId] = useState<number | null>(null);
  const palette = palettes.find((item) => item.id === paletteId) ?? palettes[0];

  useEffect(() => {
    if (palette && paletteId !== palette.id) setPaletteId(palette.id);
  }, [palette, paletteId]);

  if (!open) return null;

  return (
    <div className="inventory">
      <button
        type="button"
        className="inventory-backdrop"
        aria-label="Close inventory"
        onClick={() => engine.toggleInventory()}
      />
      <div className="inventory-card" role="dialog" aria-label="Inventory">
        <header>
          <strong>Inventory</strong>
          <span>Click a semantic to load the chosen slot</span>
          <button type="button" onClick={() => engine.toggleInventory()}>
            Close
          </button>
        </header>
        <div className="inventory-body">
          <div className="inventory-palettes" role="listbox" aria-label="Palettes">
            {palettes.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === palette?.id}
                className={item.id === palette?.id ? "active" : undefined}
                onClick={() => setPaletteId(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div className="inventory-grid">
            {palette?.semantics.map((semantic) => (
              <button
                key={`${semantic.palette}:${semantic.name}:${typeof semantic.ref === "number" ? semantic.ref : semantic.ref.base}`}
                type="button"
                className="inventory-swatch"
                title={semantic.name}
                onClick={() => {
                  const selected = engine.hotbar.state.get().selected;
                  engine.hotbar.assign(selected, semantic);
                  engine.hotbar.select((selected + 1) % HOTBAR_SLOTS);
                }}
              >
                <span
                  className={semantic.glow ? "swatch glow" : "swatch"}
                  style={{ background: semantic.color }}
                />
                <span>{semantic.name}</span>
              </button>
            ))}
            {palette && palette.semantics.length === 0 && <p>Nothing in this palette.</p>}
          </div>
        </div>
        <HotbarBar hotbar={engine.hotbar} />
      </div>
    </div>
  );
}
