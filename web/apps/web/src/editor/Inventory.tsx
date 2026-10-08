import { shapeName } from "@voxyl/shapes";
import { useEffect, useRef, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { BlockStage, blockTitle } from "./BlockPicker.tsx";
import { HotbarBar } from "./HotbarBar.tsx";
import { HOTBAR_SLOTS } from "./hotbar.ts";
import { BakedIcon, PREVIEW_PX } from "./icons.tsx";
import { PaletteEntryDialog } from "./PaletteEntry.tsx";
import { PrefabGrid } from "./prefabs.tsx";
import { SemanticEditor } from "./SemanticEditor.tsx";
import { menuAnchor, SemanticMenu, type SemanticMenuTarget } from "./SemanticMenu.tsx";
import { ShapeIcon } from "./ShapeIcon.tsx";
import { ToolButtons, ToolNotes } from "./Tools.tsx";
import { useStore } from "./useStore.ts";

/**
 * Loads the hotbar. Palettes on the left, the chosen palette's semantics as baked pictures,
 * and the same turning preview the block library uses on the right. The preview follows the
 * hotbar: opening selects that slot's semantic and its palette, and choosing another slot
 * does too. Clicking a semantic fills the chosen slot and moves to the next. A search finds
 * semantics by name, what they are for, or block. "+" opens the entry editor. Right-click
 * offers Edit or Delete. The left column holds Prefabs, the palettes and the tools; what the tool in hand does sits beside the hotbar.
 */
export function Inventory({ engine }: { engine: Engine }) {
  const open = useStore(engine.inventoryOpen);
  const palettes = useStore(engine.palettes);
  const bar = useStore(engine.hotbar.state);
  const held = bar.slots[bar.selected] ?? null;
  const [paletteId, setPaletteId] = useState<number | null>(null);
  /** The Prefabs page is shown in place of a palette. */
  const [prefabsPage, setPrefabsPage] = useState(false);
  const [query, setQuery] = useState("");
  const [semanticsOpen, setSemanticsOpen] = useState(false);
  const [menu, setMenu] = useState<SemanticMenuTarget | null>(null);
  const [editing, setEditing] = useState<{
    palette: PaletteInfo;
    semantic: SemanticInfo | null;
  } | null>(null);
  const heldRef = useRef<HTMLButtonElement>(null);
  const followed = useRef("");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (s: SemanticInfo) => terms.every((t) => searchText(s).includes(t));
  const shown = terms.length === 0 ? palettes : palettes.filter((p) => p.semantics.some(matches));
  const palette = prefabsPage
    ? undefined
    : (shown.find((item) => item.id === paletteId) ?? shown[0]);

  useEffect(() => {
    if (palette && paletteId !== palette.id) setPaletteId(palette.id);
  }, [palette, paletteId]);

  // Choosing a semantic (a slot, a click) goes back to the palettes.
  useEffect(() => {
    if (!open) setPrefabsPage(false);
  }, [open]);

  useEffect(() => {
    if (!open) {
      followed.current = "";
      setQuery("");
      setMenu(null);
      setEditing(null);
      return;
    }
    const mark = held
      ? `${bar.selected}:${held.palette}:${semanticKey(held)}`
      : `empty:${bar.selected}`;
    if (followed.current === mark) return;
    followed.current = mark;
    if (held) setPaletteId(held.palette);
  }, [open, bar.selected, held]);

  const focus = useStore(engine.inventoryFocus);
  useEffect(() => {
    if (!open || focus === null) return;
    setPrefabsPage(false);
    setPaletteId(focus);
    engine.inventoryFocus.set(null);
  }, [open, focus, engine]);

  const heldMark = held ? `${bar.selected}:${semanticKey(held)}` : "";
  const shownPalette = palette?.id;
  useEffect(() => {
    if (!open || heldMark === "" || shownPalette === undefined) return;
    heldRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, heldMark, shownPalette]);

  if (!open) return null;

  const semantics = palette?.semantics.filter((s) => terms.length === 0 || matches(s)) ?? [];
  const heldKey = held ? semanticKey(held) : null;

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
          <span>Click to load the chosen slot · right-click to edit or delete · Esc closes</span>
          <button
            type="button"
            title="Every semantic of the project in one list: rename, describe, shape, and how each palette looks them"
            onClick={() => setSemanticsOpen(true)}
          >
            Semantics
          </button>
          <button type="button" onClick={() => engine.toggleInventory()}>
            Close
          </button>
        </header>
        <div className="inventory-body">
          <div className="inventory-side">
            <button
              type="button"
              className="inventory-prefabs-button"
              aria-pressed={prefabsPage}
              title="Pieces kept from builds. Click one to paste it."
              onClick={() => setPrefabsPage(true)}
            >
              Prefabs
            </button>
            <section className="inventory-palette-list">
              <p className="inventory-side-label">Palettes</p>
              <div className="inventory-palettes" role="listbox" aria-label="Palettes">
                {shown.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={!prefabsPage && item.id === palette?.id}
                    className={!prefabsPage && item.id === palette?.id ? "active" : undefined}
                    onClick={() => {
                      setPrefabsPage(false);
                      setPaletteId(item.id);
                    }}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </section>
            <section className="inventory-tools">
              <p className="inventory-side-label">Tools</p>
              <ToolButtons engine={engine} />
            </section>
          </div>
          {prefabsPage ? (
            <div className="inventory-grid inventory-prefabs">
              <PrefabGrid engine={engine} query={query} manage={false} />
            </div>
          ) : (
            <div className="inventory-grid">
              {semantics.map((semantic) => {
                const key = semanticKey(semantic);
                const active = key === heldKey;
                return (
                  <button
                    key={key}
                    ref={active ? heldRef : undefined}
                    type="button"
                    className={active ? "inventory-swatch selected" : "inventory-swatch"}
                    aria-pressed={active}
                    title={[
                      semantic.name,
                      semantic.description,
                      semantic.block ? blockTitle(semantic.block) : "undecided",
                      semantic.shape ? shapeName(semantic.shape) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onClick={() => {
                      const chosen = engine.hotbar.state.get().selected;
                      engine.hotbar.assign(chosen, semantic);
                      engine.hotbar.select((chosen + 1) % HOTBAR_SLOTS);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!palette) return;
                      const at = menuAnchor(e.clientX, e.clientY);
                      setMenu({ ...at, palette, semantic });
                    }}
                  >
                    <BakedIcon
                      engine={engine}
                      block={semantic.block}
                      color={semantic.color}
                      className={semantic.glow ? "inventory-icon glow" : "inventory-icon"}
                    />
                    {semantic.shape && (
                      <ShapeIcon shape={semantic.shape} className="inventory-shape" />
                    )}
                    <span>{semantic.name}</span>
                  </button>
                );
              })}
              {palette && !palette.linked && terms.length === 0 && (
                <button
                  type="button"
                  className="inventory-swatch inventory-add"
                  title={`Add a semantic to ${palette.name}`}
                  onClick={() => setEditing({ palette, semantic: null })}
                >
                  <span className="swatch">+</span>
                  <span>Add</span>
                </button>
              )}
              {palette && semantics.length === 0 && terms.length > 0 && <p>No match.</p>}
            </div>
          )}
          <aside className="inventory-preview">
            {held ? (
              <>
                {held.block ? (
                  <BlockStage engine={engine} block={held.block} />
                ) : (
                  <BakedIcon
                    engine={engine}
                    block={held.block}
                    color={held.color}
                    size={PREVIEW_PX}
                    className={held.glow ? "inventory-preview-icon glow" : "inventory-preview-icon"}
                  />
                )}
                <strong>{held.name}</strong>
                <span className="home-sub">
                  {held.block ? blockTitle(held.block) : "Undecided"}
                </span>
                {held.description !== "" && <p>{held.description}</p>}
              </>
            ) : (
              <p className="home-quiet">Choose a semantic to see it.</p>
            )}
          </aside>
        </div>
        <footer className="inventory-foot">
          <ToolNotes engine={engine} />
          <HotbarBar hotbar={engine.hotbar} engine={engine} />
        </footer>
      </div>
      <SemanticMenu engine={engine} target={menu} onClose={() => setMenu(null)} />
      {semanticsOpen && <SemanticEditor engine={engine} onClose={() => setSemanticsOpen(false)} />}
      {editing && (
        <PaletteEntryDialog
          engine={engine}
          palette={editing.palette}
          semantic={editing.semantic}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function semanticKey(info: SemanticInfo): string {
  return typeof info.ref === "number" ? `#${info.ref}` : `${info.ref.palette}:${info.ref.base}`;
}

/** What a search matches: the name, what it is for, and its block. */
function searchText(s: SemanticInfo): string {
  return `${s.name} ${s.description} ${s.block ? blockTitle(s.block) : "undecided"}`.toLowerCase();
}
