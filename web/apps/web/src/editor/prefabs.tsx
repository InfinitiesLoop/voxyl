import type { PrefabEntry } from "@voxyl/session";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import { THUMB_SIZE } from "../world/clipboard.ts";
import { useStore } from "./useStore.ts";

/** Every prefab, newest first, asking again whenever the list changes. */
export function usePrefabs(engine: Engine): PrefabEntry[] {
  const rev = useStore(engine.prefabsRev);
  const [list, setList] = useState<PrefabEntry[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ask again when the revision moves
  useEffect(() => {
    let live = true;
    void engine.world.request({ type: "prefabs" }).then(
      (found) => live && setList(found),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [engine, rev]);
  return list;
}

/** A prefab's picture, as stored, drawn small. Blank while it loads or when it has none. */
export function PrefabThumb({
  engine,
  id,
  className,
}: {
  engine: Engine;
  id: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    void engine.world.request({ type: "prefabThumb", id }).then((rgba) => {
      const ctx = canvas.current?.getContext("2d");
      if (!live || !ctx) return;
      ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
      if (rgba && rgba.length === THUMB_SIZE * THUMB_SIZE * 4) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), THUMB_SIZE, THUMB_SIZE), 0, 0);
      }
    });
    return () => {
      live = false;
    };
  }, [engine, id]);
  return (
    <canvas
      ref={canvas}
      className={className ? `prefab-thumb ${className}` : "prefab-thumb"}
      width={THUMB_SIZE}
      height={THUMB_SIZE}
      aria-hidden
    />
  );
}

/** What a prefab is, in a line: its size and how many blocks. */
export function prefabSummary(entry: PrefabEntry): string {
  const [w, h, d] = entry.size;
  return `${w}×${h}×${d} · ${entry.cells.toLocaleString()} blocks`;
}

/** Whether a prefab matches a search: its name or one of its tags contains every word. */
export function prefabMatches(entry: PrefabEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${entry.name} ${entry.tags.join(" ")}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * The prefabs as picture cards: click one to take it into the clipboard and start pasting.
 * `manage` adds rename, tags and delete (Home); the inventory leaves them out.
 */
export function PrefabGrid({
  engine,
  query,
  manage,
  onUse,
}: {
  engine: Engine;
  query: string;
  manage: boolean;
  onUse?: () => void;
}) {
  const list = usePrefabs(engine);
  const shown = list.filter((entry) => prefabMatches(entry, query));
  const [editing, setEditing] = useState<string | null>(null);
  if (list.length === 0) {
    return (
      <p className="home-quiet">
        No prefabs yet. Select part of a build and press Ctrl+P (or Actions → Save as prefab) to
        keep it here, ready to place in any build.
      </p>
    );
  }
  if (shown.length === 0) return <p className="home-quiet">No prefab matches.</p>;
  return (
    <ul className="prefab-grid">
      {shown.map((entry) => (
        <li key={entry.id} className="prefab-card">
          <button
            type="button"
            className="prefab-open"
            title={`${entry.name}: ${prefabSummary(entry)}. Click to paste it.`}
            onClick={() => {
              void engine.pastePrefab(entry.id);
              onUse?.();
            }}
          >
            <PrefabThumb engine={engine} id={entry.id} />
            <strong className="prefab-name">{entry.name}</strong>
            <span className="home-sub">{prefabSummary(entry)}</span>
            {entry.tags.length > 0 && <span className="prefab-tags">{entry.tags.join(" · ")}</span>}
          </button>
          {manage &&
            (editing === entry.id ? (
              <PrefabEdit engine={engine} entry={entry} onDone={() => setEditing(null)} />
            ) : (
              <span className="home-card-tools">
                <button type="button" onClick={() => setEditing(entry.id)}>
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(`Delete the prefab ${entry.name}?`)) return;
                    void engine.world
                      .request({ type: "deletePrefab", id: entry.id })
                      .then(() => engine.prefabsRev.set(engine.prefabsRev.get() + 1));
                  }}
                >
                  Delete
                </button>
              </span>
            ))}
        </li>
      ))}
    </ul>
  );
}

function PrefabEdit({
  engine,
  entry,
  onDone,
}: {
  engine: Engine;
  entry: PrefabEntry;
  onDone: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    void engine.world
      .request({
        type: "updatePrefab",
        id: entry.id,
        name,
        tags: tags.split(",").map((t) => t.trim()),
      })
      .then(
        () => {
          engine.prefabsRev.set(engine.prefabsRev.get() + 1);
          onDone();
        },
        (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
      );
  return (
    <form
      className="prefab-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        value={name}
        aria-label="Prefab name"
        // biome-ignore lint/a11y/noAutofocus: the form opens because Rename was clicked
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <input
        value={tags}
        aria-label="Tags, separated by commas"
        placeholder="Tags, separated by commas"
        onChange={(e) => setTags(e.target.value)}
      />
      {error && <p className="palette-error">{error}</p>}
      <span className="home-card-tools">
        <button type="submit" className="primary" disabled={name.trim() === ""}>
          Save
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** "Save as a prefab": a name and tags for the selection. Opens from Ctrl+P or Actions. */
export function PrefabSaveDialog({ engine }: { engine: Engine }) {
  const open = useStore(engine.prefabDialog);
  const selection = useStore(engine.selection);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => engine.prefabDialog.set(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setTags("");
    setError(null);
    setBusy(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      engine.prefabDialog.set(false);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open, engine]);

  if (!open) return null;
  const save = () => {
    if (name.trim() === "") return;
    setBusy(true);
    void engine.savePrefab(name, tags.split(",")).then(close, (caught: unknown) => {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };
  const [w, h, d] = selection.bounds
    ? [
        selection.bounds[3] - selection.bounds[0] + 1,
        selection.bounds[4] - selection.bounds[1] + 1,
        selection.bounds[5] - selection.bounds[2] + 1,
      ]
    : [0, 0, 0];
  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={close} />
      <form
        className="keys-card prefab-save"
        role="dialog"
        aria-label="Save as a prefab"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <header>
          <strong>Save as a prefab</strong>
          <span />
          <button type="button" onClick={close}>
            Close
          </button>
        </header>
        <p className="home-sub">
          The {selection.occupied.toLocaleString()} blocks in the selection ({w}×{h}×{d}), with
          their semantics. A prefab pastes into any build, and takes the build's own look for each
          semantic it already has.
        </p>
        <label>
          Name
          <input
            value={name}
            aria-label="Name"
            // biome-ignore lint/a11y/noAutofocus: the dialog opens so the name can be typed
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Tags
          <input
            value={tags}
            aria-label="Tags, separated by commas"
            placeholder="tower, factory, …"
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        {error && <p className="palette-error">{error}</p>}
        <footer className="entry-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || name.trim() === ""}>
            Save
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
