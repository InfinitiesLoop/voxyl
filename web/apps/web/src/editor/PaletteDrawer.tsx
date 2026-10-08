import { ROOT_PALETTE } from "@voxyl/core";
import { type FormEvent, useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import type { SharedPaletteInfo } from "../world/protocol.ts";
import { BlockChooserDialog, blockTitle } from "./BlockPicker.tsx";
import { writeSemanticDrag } from "./drag.ts";
import { SemanticEditor } from "./SemanticEditor.tsx";
import { useStore } from "./useStore.ts";

/**
 * The palette drawer: semantics grouped by palette, their looks and descriptions, and new
 * palettes that inherit. A semantic drags onto the hotbar. A palette can be shared (copied to
 * your palettes, outside the project); a shared palette comes in as a linked copy, read-only
 * here and updated only when you say so. Extend one to give part of a build its own look.
 */
export function PaletteDrawer({ engine }: { engine: Engine }) {
  const palettes = useStore(engine.palettes);
  const [shared, setShared] = useState<SharedPaletteInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshShared = () =>
    void engine.world.request({ type: "sharedPalettes" }).then(setShared, () => setShared([]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the palettes change
  useEffect(refreshShared, [engine, palettes]);
  const linkedKeys = new Set(palettes.flatMap((p) => (p.linkedKey ? [p.linkedKey] : [])));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [semanticsOpen, setSemanticsOpen] = useState(false);
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
        <button
          type="button"
          title="The project's list of semantics: names, what they are for, shapes, and how each palette looks them"
          onClick={() => setSemanticsOpen(true)}
        >
          Semantics
        </button>
      </header>
      {semanticsOpen && <SemanticEditor engine={engine} onClose={() => setSemanticsOpen(false)} />}
      {error && <p className="palette-error">{error}</p>}
      {notice && <p className="palette-note">{notice}</p>}
      {picking && selected && (
        <BlockChooserDialog
          engine={engine}
          title={`Block for ${selected.semantic.name}`}
          current={selected.semantic.block ?? null}
          onClose={() => setPicking(false)}
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
      )}
      {palettes.length === 0 ? (
        <p className="palette-note">Open a project to edit its palettes.</p>
      ) : (
        <>
          <div className="palette-scroll">
            {shared.some((p) => !linkedKeys.has(p.key)) && (
              <label className="palette-use">
                Use a shared palette
                <select
                  value=""
                  onChange={(e) => {
                    const key = e.target.value;
                    if (key) void run(engine.world.request({ type: "linkPalette", key }));
                  }}
                >
                  <option value="">Choose…</option>
                  {shared
                    .filter((p) => !linkedKeys.has(p.key))
                    .map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.count})
                      </option>
                    ))}
                </select>
              </label>
            )}
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
                {palette.linked ? (
                  <LinkedNote
                    palette={palette}
                    shared={shared.find((p) => p.key === palette.linkedKey)}
                    onUpdate={(key) => void run(engine.world.request({ type: "linkPalette", key }))}
                  />
                ) : (
                  <button
                    type="button"
                    className="palette-share"
                    title="Copy this palette to your palettes, so other projects can use it"
                    onClick={() =>
                      void engine.world.request({ type: "sharePalette", palette: palette.id }).then(
                        () => {
                          setNotice(`${palette.name} is in your palettes now (Home → Palettes).`);
                          refreshShared();
                        },
                        (caught: unknown) => setError(String(caught)),
                      )
                    }
                  >
                    Share
                  </button>
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
              onDescribe={(description) =>
                run(
                  engine.world.request({
                    type: "describeSemantic",
                    semantic: selected.semantic.ref,
                    description,
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
  onDescribe,
  onLook,
  onChoose,
}: {
  semantic: SemanticInfo;
  readOnly: boolean;
  onRename: (name: string) => Promise<boolean>;
  onDescribe: (description: string) => Promise<boolean>;
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
  const [description, setDescription] = useState(semantic.description);
  useEffect(() => setDescription(semantic.description), [semantic.description]);
  const commitDescription = () => {
    if (description.trim() === semantic.description) return;
    void onDescribe(description);
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

/** A linked copy's line: which shared palette and version, and an update when one is newer. */
function LinkedNote({
  palette,
  shared,
  onUpdate,
}: {
  palette: PaletteInfo;
  shared: SharedPaletteInfo | undefined;
  onUpdate: (key: string) => void;
}) {
  const behind =
    shared && palette.linkedVersion !== undefined && shared.version > palette.linkedVersion;
  return (
    <p className="palette-note">
      A shared palette (v{palette.linkedVersion ?? 0}), read-only here. Extend it to give part of
      the build its own look.
      {behind && (
        <button type="button" onClick={() => onUpdate(shared.key)}>
          Update to v{shared.version}
        </button>
      )}
    </p>
  );
}
