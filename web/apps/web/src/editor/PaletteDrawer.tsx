import { ROOT_PALETTE } from "@voxyl/core";
import { type FormEvent, useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo } from "../world/editing.ts";
import type { SharedPaletteInfo } from "../world/protocol.ts";
import { SemanticEditor } from "./SemanticEditor.tsx";
import { useStore } from "./useStore.ts";

/**
 * The project's palettes, as a list: each with whether it is a shared palette linked in, what
 * it extends and how many semantics it holds. What a palette holds is seen and edited in the
 * inventory (Open), and the semantics all together in the Semantics editor. Below the list is
 * where a palette is added: a new one, or one of your shared palettes. A palette can be shared
 * (copied to your palettes, outside the project); a shared palette comes in as a linked copy,
 * read-only here and updated only when you say so. Extend one to give part of a build its own
 * look.
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
  const [openId, setOpenId] = useState<number | null>(null);
  const [semanticsOpen, setSemanticsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: Promise<unknown>): Promise<boolean> => {
    try {
      const applied = await work;
      if (applied !== false) setError(null);
      return applied !== false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  const addable = shared.filter((p) => !linkedKeys.has(p.key));

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
      {palettes.length === 0 ? (
        <p className="palette-note">Open a project to edit its palettes.</p>
      ) : (
        <div className="palette-scroll">
          <section aria-label="Palettes in this project">
            <h3 className="palette-heading">In this project</h3>
            <ul className="palette-rows">
              {palettes.map((palette) => (
                <PaletteRow
                  key={palette.id}
                  palette={palette}
                  parent={palettes.find((p) => p.id === palette.extends)?.name}
                  shared={shared.find((p) => p.key === palette.linkedKey)}
                  open={openId === palette.id}
                  onToggle={() => setOpenId(openId === palette.id ? null : palette.id)}
                  onOpenInventory={() => engine.showPaletteInInventory(palette.id)}
                  onRename={(name) =>
                    run(engine.world.request({ type: "renamePalette", palette: palette.id, name }))
                  }
                  onRemove={() => {
                    if (!confirm(removeQuestion(palette))) return;
                    void run(
                      engine.world.request({ type: "removePalette", palette: palette.id }),
                    ).then((ok) => {
                      if (!ok) return;
                      setOpenId(null);
                      setNotice(
                        palette.linked
                          ? `${palette.name} is out of this project. It is still in your shared palettes.`
                          : `${palette.name} is removed. Undo brings it back.`,
                      );
                    });
                  }}
                  onUpdate={(key) => void run(engine.world.request({ type: "linkPalette", key }))}
                  onLocal={() =>
                    void run(engine.world.request({ type: "unlinkPalette", palette: palette.id }))
                  }
                  onShare={() =>
                    void run(
                      engine.world
                        .request({ type: "sharePalette", palette: palette.id })
                        .then(() => {
                          setNotice(`${palette.name} is in your palettes now (Home → Palettes).`);
                          refreshShared();
                        }),
                    )
                  }
                  onMakeShared={() => {
                    if (!confirm(makeSharedQuestion(palette))) return;
                    void run(
                      engine.world
                        .request({ type: "sharePalette", palette: palette.id, link: true })
                        .then(() => {
                          setNotice(`${palette.name} is a shared palette now (Home → Palettes).`);
                          refreshShared();
                        }),
                    );
                  }}
                />
              ))}
            </ul>
          </section>
          <section className="palette-new" aria-label="Add a palette">
            <h3 className="palette-new-title">Add a palette</h3>
            <AddPalette
              palettes={palettes}
              onAdd={(name, parent) =>
                run(
                  engine.world.request({
                    type: "addPalette",
                    name,
                    ...(parent !== undefined && { extends: parent }),
                  }),
                )
              }
            />
            <div className="palette-new-part">
              <h4>Or use one of yours</h4>
              {addable.length === 0 ? (
                <p className="palette-offer-note">
                  {shared.length === 0
                    ? "You have no shared palettes yet. Share one from the list above, or start from Home → Palettes."
                    : "Every shared palette you have is already in this project."}
                </p>
              ) : (
                <ul className="palette-rows">
                  {addable.map((item) => (
                    <li key={item.key} className="palette-offer">
                      <span className="palette-offer-text">
                        <span className="palette-title">{item.name}</span>
                        <span className="palette-meta">
                          {item.count} {item.count === 1 ? "semantic" : "semantics"}
                          {item.description ? ` · ${item.description}` : ""}
                        </span>
                      </span>
                      <button
                        type="button"
                        title="Bring it in as a linked copy: read-only here, kept up to date when you say so"
                        onClick={() =>
                          void run(engine.world.request({ type: "linkPalette", key: item.key }))
                        }
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}

/** What removing a palette asks: which palette, and whether a shared one is lost or only left. */
export function removeQuestion(palette: PaletteInfo): string {
  if (palette.linked) {
    return `Remove "${palette.name}" from this project?\n\nIt is a link to one of your shared palettes, so the shared palette is not going away: only this project stops using it. You can add it again from your shared palettes.`;
  }
  return `Remove "${palette.name}" from this project?\n\nIt is not a shared palette, so it and its semantics are gone from this project. Undo brings it back right after.`;
}

function makeSharedQuestion(palette: PaletteInfo): string {
  return `Make ${palette.name} a shared palette? It stays in this build as a linked copy you can't edit here: change it from Home → Palettes, and update the builds that use it. Undo brings it back.`;
}

function LinkIcon({ linked, title }: { linked: boolean; title: string }) {
  return (
    <span
      className={linked ? "palette-link on" : "palette-link"}
      role="img"
      aria-label={title}
      title={title}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function PaletteRow({
  palette,
  parent,
  shared,
  open,
  onToggle,
  onOpenInventory,
  onRename,
  onRemove,
  onUpdate,
  onLocal,
  onShare,
  onMakeShared,
}: {
  palette: PaletteInfo;
  parent: string | undefined;
  shared: SharedPaletteInfo | undefined;
  open: boolean;
  onToggle: () => void;
  onOpenInventory: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
  onUpdate: (key: string) => void;
  onLocal: () => void;
  onShare: () => void;
  onMakeShared: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(palette.name);
  useEffect(() => setName(palette.name), [palette.name]);
  const commit = () => {
    setRenaming(false);
    const trimmed = name.trim();
    if (trimmed === palette.name) return;
    void onRename(trimmed).then((ok) => {
      if (!ok) setName(palette.name);
    });
  };
  const own = palette.semantics.filter((s) => typeof s.ref === "number").length;
  const behind =
    palette.linked &&
    shared !== undefined &&
    palette.linkedVersion !== undefined &&
    shared.version > palette.linkedVersion;
  return (
    <li className={open ? "palette-row open" : "palette-row"}>
      <div className="palette-row-main">
        <LinkIcon
          linked={palette.linked}
          title={
            palette.linked
              ? `A shared palette, linked (v${palette.linkedVersion ?? 0}): read-only here`
              : "Not shared: only this project has it"
          }
        />
        {renaming && !palette.linked ? (
          <input
            value={name}
            aria-label="Palette name"
            // biome-ignore lint/a11y/noAutofocus: the field exists only because Rename was clicked
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(palette.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="palette-row-name"
            aria-expanded={open}
            title="Show what you can do with it"
            onClick={onToggle}
          >
            <span className="palette-title">{palette.name}</span>
            <span className="palette-meta">
              {own} {own === 1 ? "semantic" : "semantics"}
              {parent ? ` · extends ${parent}` : ""}
              {behind ? " · update available" : ""}
            </span>
          </button>
        )}
        {palette.id !== ROOT_PALETTE && (
          <button
            type="button"
            className="palette-remove"
            aria-label={`Remove ${palette.name}`}
            title="Remove it from this project"
            onClick={onRemove}
          >
            ✕
          </button>
        )}
      </div>
      {open && (
        <div className="palette-row-detail">
          <div className="palette-actions">
            <button
              type="button"
              title="See what it holds, and edit it, in the inventory"
              onClick={onOpenInventory}
            >
              Open
            </button>
            {!palette.linked && (
              <button type="button" onClick={() => setRenaming(true)}>
                Rename
              </button>
            )}
            {palette.linked ? (
              <>
                {behind && shared && (
                  <button type="button" onClick={() => onUpdate(shared.key)}>
                    Update to v{shared.version}
                  </button>
                )}
                <button
                  type="button"
                  title="Stop following the shared palette: this becomes an ordinary palette you edit here"
                  onClick={onLocal}
                >
                  Make a local copy
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  title="Copy this palette to your palettes, so other projects can use it"
                  onClick={onShare}
                >
                  Share a copy
                </button>
                {palette.canLink && (
                  <button
                    type="button"
                    title="Move this palette to your shared palettes and use it here as a linked copy: it becomes read-only in this build, and you edit it from Home"
                    onClick={onMakeShared}
                  >
                    Make shared
                  </button>
                )}
              </>
            )}
          </div>
          {palette.linked && (
            <p className="palette-detail-note">
              Read-only here. Extend it from a new palette to give part of the build its own look.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function AddPalette({
  palettes,
  onAdd,
}: {
  palettes: readonly PaletteInfo[];
  onAdd: (name: string, parent: number | undefined) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState(String(ROOT_PALETTE));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    void onAdd(trimmed, parent === "" ? undefined : Number(parent)).then((ok) => {
      if (ok) setName("");
    });
  };
  return (
    <form className="palette-new-form" onSubmit={submit}>
      <h4>Start a new one</h4>
      <label>
        Name
        <input
          value={name}
          placeholder="Walkway, Night, Cabin…"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Builds on
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Nothing: starts empty</option>
          {palettes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}: its semantics, to re-skin
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary" disabled={name.trim() === ""}>
        Create palette
      </button>
    </form>
  );
}
