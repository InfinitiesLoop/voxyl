import { blockLabel } from "@voxyl/blocks";
import { ROOT_PALETTE } from "@voxyl/core";
import { type FormEvent, useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import type { BlockSearch } from "../world/protocol.ts";
import { writeSemanticDrag } from "./drag.ts";
import { useStore } from "./useStore.ts";

/**
 * The palette drawer: semantics grouped by palette, their looks, and new palettes that
 * inherit. A semantic drags onto the hotbar. Linked palettes stay read-only; extend one
 * to give part of a build its own look.
 */
export function PaletteDrawer({ engine }: { engine: Engine }) {
  const palettes = useStore(engine.palettes);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = findSemantic(palettes, selectedKey);

  const run = async (work: Promise<boolean>): Promise<boolean> => {
    try {
      const applied = await work;
      if (applied) setError(null);
      return applied;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  const select = (info: SemanticInfo) => {
    setPicking(false);
    setSelectedKey(semanticKey(info));
  };

  return (
    <aside className="palette-drawer">
      <header className="palette-head">
        <strong>Palettes</strong>
        {picking && (
          <button type="button" onClick={() => setPicking(false)}>
            Back
          </button>
        )}
      </header>
      {error && <p className="palette-error">{error}</p>}
      {palettes.length === 0 ? (
        <p className="palette-note">Open a project to edit its palettes.</p>
      ) : picking && selected ? (
        <BlockPicker
          engine={engine}
          onPick={(ref) => {
            const own = selected.semantic.ownLook;
            if (ref === null && own.block === undefined) {
              if (selected.semantic.block) {
                setError("That block is inherited. Pick another, or use the inherited look.");
              }
              setPicking(false);
              return;
            }
            void run(
              engine.world.request({
                type: "setLook",
                semantic: selected.semantic.ref,
                look: nextLook(selected.semantic, ref ? { ...own, block: ref } : omitBlock(own)),
              }),
            );
            setPicking(false);
          }}
        />
      ) : (
        <>
          <div className="palette-scroll">
            <AddPalette
              palettes={palettes}
              onAdd={(name, parent) =>
                void run(
                  engine.world.request({
                    type: "addPalette",
                    name,
                    ...(parent !== undefined && { extends: parent }),
                  }),
                )
              }
            />
            {palettes.map((palette) => (
              <section key={palette.id} className="palette-section">
                <PaletteName
                  palette={palette}
                  parent={palettes.find((p) => p.id === palette.extends)?.name}
                  onRename={(name) =>
                    run(engine.world.request({ type: "renamePalette", palette: palette.id, name }))
                  }
                />
                {palette.linked && (
                  <p className="palette-note">
                    A linked theme. Extend it to give part of the build its own look.
                  </p>
                )}
                <ul className="semantic-list">
                  {palette.semantics.map((semantic) => (
                    <li key={semanticKey(semantic)}>
                      <button
                        type="button"
                        className={
                          semanticKey(semantic) === selectedKey
                            ? "semantic-row selected"
                            : "semantic-row"
                        }
                        draggable
                        aria-pressed={semanticKey(semantic) === selectedKey}
                        title="Drag onto the hotbar. Double-click fills the chosen slot."
                        onClick={() => select(semantic)}
                        onDoubleClick={() =>
                          engine.hotbar.assign(engine.hotbar.state.get().selected, semantic)
                        }
                        onDragStart={(e) => {
                          if (e.dataTransfer) writeSemanticDrag(e.dataTransfer, semantic);
                        }}
                      >
                        <span
                          className={semantic.glow ? "swatch glow" : "swatch"}
                          style={{ background: semantic.color }}
                        />
                        <span className="semantic-name">{semantic.name}</span>
                        {semantic.base !== undefined && (
                          <span className="semantic-from">inherited</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                {!palette.linked && (
                  <AddSemantic
                    onAdd={(name) =>
                      void run(
                        engine.world.request({
                          type: "addSemantic",
                          palette: palette.id,
                          name,
                        }),
                      )
                    }
                  />
                )}
              </section>
            ))}
          </div>
          {selected && (
            <LookEditor
              semantic={selected.semantic}
              readOnly={selected.palette.linked}
              onRename={(name) =>
                run(
                  engine.world.request({
                    type: "renameSemantic",
                    semantic: selected.semantic.ref,
                    name,
                  }),
                )
              }
              onLook={(look) =>
                run(
                  engine.world.request({
                    type: "setLook",
                    semantic: selected.semantic.ref,
                    look,
                  }),
                )
              }
              onChoose={() => setPicking(true)}
            />
          )}
        </>
      )}
    </aside>
  );
}

function semanticKey(info: SemanticInfo): string {
  return typeof info.ref === "number" ? `#${info.ref}` : `${info.ref.palette}:${info.ref.base}`;
}

function findSemantic(
  palettes: readonly PaletteInfo[],
  key: string | null,
): { palette: PaletteInfo; semantic: SemanticInfo } | null {
  if (key === null) return null;
  for (const palette of palettes) {
    const semantic = palette.semantics.find((s) => semanticKey(s) === key);
    if (semantic) return { palette, semantic };
  }
  return null;
}

/** The look without its block, so a semantic goes back to undecided or to what it inherits. */
function omitBlock(look: SemanticInfo["ownLook"]): SemanticInfo["ownLook"] {
  return {
    ...(look.tint !== undefined && { tint: look.tint }),
    ...(look.glow !== undefined && { glow: look.glow }),
  };
}

/** What setLook should store. An empty look on a derived semantic goes back to its base. */
function nextLook(
  semantic: SemanticInfo,
  look: SemanticInfo["ownLook"] | null,
): SemanticInfo["ownLook"] | null {
  if (look === null || (Object.keys(look).length === 0 && semantic.base !== undefined)) return null;
  return look;
}

function PaletteName({
  palette,
  parent,
  onRename,
}: {
  palette: PaletteInfo;
  parent: string | undefined;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(palette.name);
  useEffect(() => setName(palette.name), [palette.name]);
  const commit = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed === palette.name) return;
    void onRename(trimmed).then((ok) => {
      if (!ok) setName(palette.name);
    });
  };
  return (
    <div className="palette-name">
      {editing && !palette.linked ? (
        <input
          value={name}
          aria-label="Palette name"
          // biome-ignore lint/a11y/noAutofocus: the field exists only because the name was clicked
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(palette.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="name-button"
          disabled={palette.linked}
          title={palette.linked ? palette.name : "Rename"}
          onClick={() => setEditing(true)}
        >
          {palette.name}
        </button>
      )}
      {parent && <span className="extends">extends {parent}</span>}
    </div>
  );
}

function AddPalette({
  palettes,
  onAdd,
}: {
  palettes: readonly PaletteInfo[];
  onAdd: (name: string, parent: number | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState(String(ROOT_PALETTE));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd(trimmed, parent === "" ? undefined : Number(parent));
    setName("");
  };
  return (
    <form className="palette-add" onSubmit={submit}>
      <input
        value={name}
        placeholder="New palette"
        aria-label="New palette"
        onChange={(e) => setName(e.target.value)}
      />
      <select aria-label="Extends" value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">Extends nothing</option>
        {palettes.map((p) => (
          <option key={p.id} value={p.id}>
            Extends {p.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={name.trim() === ""}>
        Add
      </button>
    </form>
  );
}

function AddSemantic({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="semantic-add"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed === "") return;
        onAdd(trimmed);
        setName("");
      }}
    >
      <input
        value={name}
        placeholder="New semantic"
        aria-label="New semantic"
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={name.trim() === ""}>
        Add
      </button>
    </form>
  );
}

function LookEditor({
  semantic,
  readOnly,
  onRename,
  onLook,
  onChoose,
}: {
  semantic: SemanticInfo;
  readOnly: boolean;
  onRename: (name: string) => Promise<boolean>;
  onLook: (look: SemanticInfo["ownLook"] | null) => Promise<boolean>;
  onChoose: () => void;
}) {
  const [name, setName] = useState(semantic.name);
  useEffect(() => setName(semantic.name), [semantic.name]);
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === semantic.name) return;
    void onRename(trimmed).then((ok) => {
      if (!ok) setName(semantic.name);
    });
  };
  const inherited = semantic.base !== undefined && Object.keys(semantic.ownLook).length === 0;
  return (
    <form
      className="look-editor"
      onSubmit={(e) => {
        e.preventDefault();
        commitName();
      }}
    >
      <label>
        Name
        <input
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
        />
      </label>
      <div className="look-block">
        <span
          className={semantic.glow ? "swatch glow" : "swatch"}
          style={{ background: semantic.color }}
        />
        <span className="look-block-name">
          {semantic.block ? blockTitle(semantic.block) : "Undecided"}
        </span>
        <button type="button" disabled={readOnly} onClick={onChoose}>
          Choose
        </button>
        {semantic.ownLook.block && (
          <button
            type="button"
            disabled={readOnly}
            onClick={() => void onLook(nextLook(semantic, omitBlock(semantic.ownLook)))}
          >
            Clear
          </button>
        )}
      </div>
      <label>
        Fallback colour
        <input
          type="color"
          value={semantic.ownLook.tint ?? semantic.color}
          disabled={readOnly}
          title="How it draws when no block is chosen, or this browser doesn't have it"
          onChange={(e) => void onLook({ ...semantic.ownLook, tint: e.target.value })}
        />
      </label>
      <label className="look-glow">
        <input
          type="checkbox"
          checked={semantic.glow}
          disabled={readOnly}
          onChange={(e) => void onLook({ ...semantic.ownLook, glow: e.target.checked })}
        />
        Glows
      </label>
      {inherited && <p className="palette-note">Using the look it inherits.</p>}
      {semantic.base !== undefined && Object.keys(semantic.ownLook).length > 0 && !readOnly && (
        <button type="button" onClick={() => void onLook(null)}>
          Use the inherited look
        </button>
      )}
    </form>
  );
}

/** "voxyl:oak_stairs" as "Oak stairs"; another library keeps its name. */
function blockTitle(ref: string): string {
  const colon = ref.indexOf(":");
  const library = colon > 0 ? ref.slice(0, colon) : "";
  const name = blockLabel(ref);
  return library === "" || library === "voxyl" ? name : `${name} · ${library}`;
}

const ICON = 16 * 16 * 4;

function BlockPicker({ engine, onPick }: { engine: Engine; onPick: (ref: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("");
  const [pending, setPending] = useState("");
  const [result, setResult] = useState<BlockSearch | null>(null);
  useEffect(() => {
    const handle = setTimeout(() => setPending(query), 120);
    return () => clearTimeout(handle);
  }, [query]);
  useEffect(() => {
    let cancel = false;
    void engine.world
      .request({
        type: "findBlocks",
        query: pending,
        ...(library !== "" && { library }),
      })
      .then((found) => {
        if (!cancel) setResult(found);
      })
      .catch((caught: unknown) => {
        if (!cancel) console.error(caught);
      });
    return () => {
      cancel = true;
    };
  }, [engine, pending, library]);
  return (
    <div className="block-picker">
      <input
        value={query}
        placeholder="Search blocks"
        aria-label="Search blocks"
        onChange={(e) => setQuery(e.target.value)}
      />
      <select aria-label="Library" value={library} onChange={(e) => setLibrary(e.target.value)}>
        <option value="">All libraries</option>
        {(result?.libraries ?? []).map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button type="button" className="undecided" onClick={() => onPick(null)}>
        No block
      </button>
      {result && result.matched > result.hits.length && (
        <p className="palette-note">
          Showing {result.hits.length} of {result.matched}. Keep typing.
        </p>
      )}
      <div className="block-grid">
        {result?.hits.map((hit, i) => (
          <button
            key={hit.ref}
            type="button"
            className="block-choice"
            title={hit.ref}
            onClick={() => onPick(hit.ref)}
          >
            <BlockIcon icons={result.icons} index={i} color={hit.color} />
            <span>{hit.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockIcon({ icons, index, color }: { icons: Uint8Array; index: number; color: string }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const slice = icons.subarray(index * ICON, index * ICON + ICON);
    let textured = false;
    for (let i = 3; i < slice.length; i += 4) {
      if (slice[i] !== 0) {
        textured = true;
        break;
      }
    }
    if (!textured || slice.length < ICON) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 16, 16);
      return;
    }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(slice), 16, 16), 0, 0);
  }, [canvas, icons, index, color]);
  return <canvas ref={setCanvas} width={16} height={16} className="block-icon" />;
}
