import { useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { blockTitle } from "./BlockPicker.tsx";
import { HotbarBar } from "./HotbarBar.tsx";
import { HOTBAR_SLOTS } from "./hotbar.ts";
import { ToolStrip } from "./Tools.tsx";
import { useStore } from "./useStore.ts";

/**
 * Loads the hotbar. Palettes on the left, the chosen palette's semantics as swatches,
 * and the same hotbar as the workspace. Clicking a semantic fills the chosen slot and
 * moves to the next. A search finds semantics by name, what they are for, or block, across
 * palettes, and narrows the palette list to those with a match. The "+" tile adds a
 * semantic to the palette; right-clicking one removes it (refused while cells use it).
 * Editing a look stays in the palette drawer. The tools sit beside its hotbar, so a tool is
 * chosen here too (E or Delete opens it).
 */
export function Inventory({ engine }: { engine: Engine }) {
  const open = useStore(engine.inventoryOpen);
  const palettes = useStore(engine.palettes);
  const [paletteId, setPaletteId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (s: SemanticInfo) => terms.every((t) => searchText(s).includes(t));
  const shown = terms.length === 0 ? palettes : palettes.filter((p) => p.semantics.some(matches));
  const palette = shown.find((item) => item.id === paletteId) ?? shown[0];

  useEffect(() => {
    if (palette && paletteId !== palette.id) setPaletteId(palette.id);
  }, [palette, paletteId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const run = (work: Promise<unknown>) =>
    void work.then(
      () => setError(null),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  const add = (into: PaletteInfo) => {
    const name = prompt(`A new semantic in ${into.name}`, "");
    if (name?.trim()) run(engine.world.request({ type: "addSemantic", palette: into.id, name }));
  };
  const remove = (into: PaletteInfo, semantic: SemanticInfo) => {
    if (into.linked || typeof semantic.ref !== "number") {
      setError(
        into.linked
          ? `${into.name} is a shared palette: change it from Home.`
          : `${semantic.name} comes from a parent palette: remove it there.`,
      );
      return;
    }
    if (!confirm(`Remove ${semantic.name} from ${into.name}?`)) return;
    run(engine.world.request({ type: "removeSemantic", semantic: semantic.ref }));
  };
  const semantics = palette?.semantics.filter((s) => terms.length === 0 || matches(s)) ?? [];

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
          <input
            className="inventory-search"
            value={query}
            placeholder="Search: a name, what it is for, or a block"
            aria-label="Search semantics"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>Click to load the chosen slot · right-click removes · E, Delete or Esc closes</span>
          <button type="button" onClick={() => engine.toggleInventory()}>
            Close
          </button>
        </header>
        {error && <p className="palette-error">{error}</p>}
        <div className="inventory-body">
          <div className="inventory-palettes" role="listbox" aria-label="Palettes">
            {shown.map((item) => (
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
            {semantics.map((semantic) => (
              <button
                key={`${semantic.palette}:${semantic.name}:${typeof semantic.ref === "number" ? semantic.ref : semantic.ref.base}`}
                type="button"
                className="inventory-swatch"
                title={[
                  semantic.name,
                  semantic.description,
                  semantic.block ? blockTitle(semantic.block) : "undecided",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => {
                  const selected = engine.hotbar.state.get().selected;
                  engine.hotbar.assign(selected, semantic);
                  engine.hotbar.select((selected + 1) % HOTBAR_SLOTS);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (palette) remove(palette, semantic);
                }}
              >
                <span
                  className={semantic.glow ? "swatch glow" : "swatch"}
                  style={{ background: semantic.color }}
                />
                <span>{semantic.name}</span>
              </button>
            ))}
            {palette && !palette.linked && terms.length === 0 && (
              <button
                type="button"
                className="inventory-swatch inventory-add"
                title={`Add a semantic to ${palette.name}`}
                onClick={() => add(palette)}
              >
                <span className="swatch">+</span>
                <span>Add</span>
              </button>
            )}
            {palette && semantics.length === 0 && terms.length > 0 && <p>No match.</p>}
          </div>
        </div>
        <footer className="inventory-foot">
          <ToolStrip engine={engine} />
          <HotbarBar hotbar={engine.hotbar} />
        </footer>
      </div>
    </div>
  );
}

/** What a search matches: the name, what it is for, and its block. */
function searchText(s: SemanticInfo): string {
  return `${s.name} ${s.description} ${s.block ? blockTitle(s.block) : "undecided"}`.toLowerCase();
}
