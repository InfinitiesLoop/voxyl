import { type Form, ROOT_PALETTE } from "@voxyl/core";
import { shapeName } from "@voxyl/shapes";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import {
  type PaletteInfo,
  PLACEMENT_CHOICES,
  placementOf,
  type SemanticInfo,
} from "../world/editing.ts";
import { BlockChooserDialog, blockTitle } from "./BlockPicker.tsx";
import { ShapeIcon } from "./ShapeIcon.tsx";
import { ShapePicker } from "./ShapePicker.tsx";
import { useStore } from "./useStore.ts";

/** One semantic of the project, and where each palette stands on how it looks. */
export interface RegistryEntry {
  /** The semantic itself: the one that owns the name, what it is for, and its shape. */
  readonly root: SemanticInfo;
  readonly rootPalette: PaletteInfo;
  /** Every palette that can place it, with the entry it places (its own or a derived one). */
  readonly looks: readonly { readonly palette: PaletteInfo; readonly info: SemanticInfo }[];
}

/** The id a semantic info stands for, or its base's while it is only offered. */
function idOf(info: SemanticInfo): number {
  return typeof info.ref === "number" ? info.ref : info.ref.base;
}

/**
 * Every semantic of the project once, however many palettes offer it. A palette doesn't define
 * which semantics exist: it maps them to looks. Names, descriptions and shapes belong to the
 * semantic, so they are edited here, once, and every palette follows.
 */
export function registryOf(palettes: readonly PaletteInfo[]): RegistryEntry[] {
  const byId = new Map<number, SemanticInfo>();
  for (const p of palettes) {
    for (const s of p.semantics) if (typeof s.ref === "number") byId.set(s.ref, s);
  }
  const rootOf = (info: SemanticInfo): number => {
    let current = info;
    for (let guard = 0; guard < 64; guard++) {
      if (current.base === undefined) return idOf(current);
      const next = byId.get(current.base);
      if (!next) return current.base;
      current = next;
    }
    return idOf(current);
  };
  const entries: RegistryEntry[] = [];
  for (const palette of palettes) {
    for (const info of palette.semantics) {
      if (typeof info.ref !== "number" || info.base !== undefined) continue;
      const looks = palettes.flatMap((p) =>
        p.semantics.filter((s) => rootOf(s) === info.ref).map((s) => ({ palette: p, info: s })),
      );
      entries.push({ root: info, rootPalette: palette, looks });
    }
  }
  return entries;
}

/**
 * The project's semantics, top level: what each is called, what it is for, its shape and how
 * whole blocks of it turn, and which look each palette gives it. A rename here touches no
 * cell and no palette's looks. Palettes only map; a semantic is never defined by one.
 */
export function SemanticEditor({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const palettes = useStore(engine.palettes);
  const entries = registryOf(palettes);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) =>
    terms.every((t) => `${e.root.name} ${e.root.description}`.toLowerCase().includes(t)),
  );
  const current = entries.find((e) => e.root.ref === selected) ?? shown[0] ?? entries[0] ?? null;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const run = async (work: Promise<unknown>): Promise<boolean> => {
    try {
      await work;
      setError(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  const add = (name: string, palette: number) =>
    run(engine.world.request({ type: "addSemantic", palette, name }));

  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={onClose} />
      <div className="keys-card chooser-card semantic-card" role="dialog" aria-label="Semantics">
        <header>
          <strong>Semantics</strong>
          <span>
            The project's list of what things are. A palette only says what each looks like.
          </span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {error && <p className="palette-error">{error}</p>}
        <div className="semantic-body">
          <div className="semantic-index">
            <input
              value={query}
              placeholder="Search"
              aria-label="Search semantics"
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul className="semantic-index-list">
              {shown.map((entry) => (
                <li key={String(entry.root.ref)}>
                  <button
                    type="button"
                    aria-pressed={entry === current}
                    className={entry === current ? "semantic-row selected" : "semantic-row"}
                    onClick={() => setSelected(entry.root.ref as number)}
                  >
                    <span
                      className={entry.root.glow ? "swatch glow" : "swatch"}
                      style={{ background: entry.root.color }}
                    />
                    <span className="semantic-name">{entry.root.name}</span>
                    {entry.root.shape && (
                      <ShapeIcon shape={entry.root.shape} className="semantic-shape" />
                    )}
                    {entry.looks.length > 1 && (
                      <span className="semantic-from">{entry.looks.length} palettes</span>
                    )}
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="home-quiet">No semantic matches.</li>}
            </ul>
            <AddRow palettes={palettes} onAdd={add} />
          </div>
          {current ? (
            <Detail
              key={String(current.root.ref)}
              engine={engine}
              entry={current}
              palettes={palettes}
              run={run}
              onRemoved={() => setSelected(null)}
            />
          ) : (
            <p className="home-quiet">Open a project to see its semantics.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AddRow({
  palettes,
  onAdd,
}: {
  palettes: readonly PaletteInfo[];
  onAdd: (name: string, palette: number) => Promise<boolean>;
}) {
  const writable = palettes.filter((p) => !p.linked);
  const [name, setName] = useState("");
  const [palette, setPalette] = useState<number>(ROOT_PALETTE);
  const chosen = writable.find((p) => p.id === palette) ?? writable[0];
  return (
    <form
      className="semantic-add semantic-add-row"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed === "" || !chosen) return;
        void onAdd(trimmed, chosen.id).then((ok) => ok && setName(""));
      }}
    >
      <input
        value={name}
        placeholder="New semantic"
        aria-label="New semantic"
        onChange={(e) => setName(e.target.value)}
      />
      <select
        aria-label="Palette it starts in"
        title="The palette it starts in. Other palettes that extend it can place it too."
        value={chosen?.id ?? ""}
        onChange={(e) => setPalette(Number(e.target.value))}
      >
        {writable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={name.trim() === "" || !chosen}>
        Add
      </button>
    </form>
  );
}

function Detail({
  engine,
  entry,
  palettes,
  run,
  onRemoved,
}: {
  engine: Engine;
  entry: RegistryEntry;
  palettes: readonly PaletteInfo[];
  run: (work: Promise<unknown>) => Promise<boolean>;
  onRemoved: () => void;
}) {
  const { root, rootPalette } = entry;
  const readOnly = rootPalette.linked;
  const [name, setName] = useState(root.name);
  const [description, setDescription] = useState(root.description);
  const [picking, setPicking] = useState<SemanticInfo | null>(null);
  useEffect(() => setName(root.name), [root.name]);
  useEffect(() => setDescription(root.description), [root.description]);

  const ref = root.ref;
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === root.name) return;
    void run(engine.world.request({ type: "renameSemantic", semantic: ref, name: trimmed })).then(
      (ok) => {
        if (!ok) setName(root.name);
      },
    );
  };
  const commitDescription = () => {
    if (description.trim() === root.description) return;
    void run(engine.world.request({ type: "describeSemantic", semantic: ref, description }));
  };
  const setForm = (form: Form | null) =>
    run(
      engine.world.request({
        type: "editSemantic",
        semantic: ref,
        name: root.name,
        description: root.description,
        look: Object.keys(root.ownLook).length > 0 ? root.ownLook : null,
        form,
      }),
    );
  const shape = root.shape ?? null;
  const profile =
    shape === null && root.placement !== "auto" ? placementOf(root.placement) : undefined;
  const changeShape = (next: string | null) =>
    setForm({
      ...(next ? { shape: next } : {}),
      ...(!next && profile ? { placement: profile } : {}),
    });
  const changePlacement = (next: string) => {
    const chosen = placementOf(next);
    void setForm({ ...(shape ? { shape } : {}), ...(chosen ? { placement: chosen } : {}) });
  };

  const remove = () =>
    run(engine.world.request({ type: "removeSemantic", semantic: ref })).then(
      (ok) => ok && onRemoved(),
    );

  return (
    <section className="semantic-detail">
      {picking && (
        <BlockChooserDialog
          engine={engine}
          title={`Block for ${picking.name} in ${palettes.find((p) => p.id === picking.palette)?.name ?? ""}`}
          current={picking.block ?? null}
          onClose={() => setPicking(null)}
          onPick={(block) => {
            const own = picking.ownLook;
            const next = block
              ? { ...own, block }
              : {
                  ...(own.tint !== undefined && { tint: own.tint }),
                  ...(own.glow !== undefined && { glow: own.glow }),
                };
            void run(
              engine.world.request({
                type: "setLook",
                semantic: picking.ref,
                look: Object.keys(next).length === 0 && picking.base !== undefined ? null : next,
              }),
            );
            setPicking(null);
          }}
        />
      )}
      <label>
        Name
        <input
          value={name}
          disabled={readOnly}
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </label>
      <p className="palette-note">
        Cells keep the semantic, not its name, so renaming it changes no cell and breaks no palette.
        Palettes that inherit the name follow.
      </p>
      <label>
        What it is for
        <textarea
          value={description}
          rows={2}
          disabled={readOnly}
          placeholder="A line on what this is for: teammates and agents read it"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
        />
      </label>
      <div className="semantic-form">
        <div className="entry-shape">
          <span>Shape</span>
          <ShapePicker shape={shape} onChange={(s) => void changeShape(s)} disabled={readOnly} />
        </div>
        {shape === null && (
          <label>
            Placing
            <select
              aria-label="Placing"
              disabled={readOnly}
              title="How whole blocks of this turn when placed. By default, as the block it looks like does."
              value={root.placement}
              onChange={(e) => changePlacement(e.target.value)}
            >
              {PLACEMENT_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
              {root.placement === "custom" && <option value="custom">Custom</option>}
            </select>
          </label>
        )}
      </div>
      <h3>Looks, by palette</h3>
      <table className="semantic-looks">
        <thead>
          <tr>
            <th>Palette</th>
            <th>Looks like</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entry.looks.map(({ palette, info }) => {
            const own = typeof info.ref === "number" && Object.keys(info.ownLook).length > 0;
            const inherits = info.base !== undefined && !own;
            return (
              <tr key={palette.id}>
                <td>
                  {palette.name}
                  {palette.id === rootPalette.id && <span className="semantic-from">home</span>}
                </td>
                <td>
                  <span className="semantic-look">
                    <span
                      className={info.glow ? "swatch glow" : "swatch"}
                      style={{ background: info.color }}
                    />
                    {info.block ? blockTitle(info.block) : "Undecided"}
                    {inherits && <span className="semantic-from">inherited</span>}
                  </span>
                </td>
                <td className="semantic-look-actions">
                  <button
                    type="button"
                    disabled={palette.linked}
                    title={palette.linked ? "A shared palette: change it from Home" : undefined}
                    onClick={() => setPicking(info)}
                  >
                    Choose block
                  </button>
                  {own && info.base !== undefined && (
                    <button
                      type="button"
                      disabled={palette.linked}
                      onClick={() =>
                        void run(
                          engine.world.request({
                            type: "setLook",
                            semantic: info.ref,
                            look: null,
                          }),
                        )
                      }
                    >
                      Use the inherited look
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <footer className="semantic-foot">
        <button
          type="button"
          disabled={readOnly}
          title="Remove it. Refused while any cell uses it, or another palette derives from it."
          onClick={() => void remove()}
        >
          Delete {root.name}
        </button>
        {shape && <span className="home-sub">Places {shapeName(shape).toLowerCase()} parts</span>}
      </footer>
    </section>
  );
}
