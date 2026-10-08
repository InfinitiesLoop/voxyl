import type { Look } from "@voxyl/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { BlockChooser } from "./BlockPicker.tsx";

/**
 * New or edit a palette entry, the way the Godot app does: a name (already filled in) and
 * the block chooser, so the block is picked here rather than asked for first. Nothing is
 * written until Create or Save.
 */
export function PaletteEntryDialog({
  engine,
  palette,
  semantic,
  onClose,
}: {
  engine: Engine;
  palette: PaletteInfo;
  /** Null creates an entry. Otherwise the one being edited. */
  semantic: SemanticInfo | null;
  onClose: () => void;
}) {
  const creating = semantic === null;
  const [name, setName] = useState(semantic?.name ?? freshName(palette));
  const [description, setDescription] = useState(semantic?.description ?? "");
  const [block, setBlock] = useState<string | null>(semantic?.block ?? null);
  const [glow, setGlow] = useState(semantic?.glow ?? false);
  const [tint, setTint] = useState(semantic?.ownLook.tint ?? semantic?.color ?? "#9aa0a8");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);

  const save = () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Give it a name.");
      return;
    }
    const look: Look = {
      ...(block ? { block } : {}),
      ...(glow ? { glow: true } : {}),
      tint,
    };
    setBusy(true);
    const work = creating
      ? engine.world.request({
          type: "addSemantic",
          palette: palette.id,
          name: trimmed,
          ...(description.trim() !== "" && { description: description.trim() }),
          look,
        })
      : engine.world.request({
          type: "editSemantic",
          semantic: semantic.ref,
          name: trimmed,
          description,
          look,
        });
    void work.then(
      () => onClose(),
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  };

  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={onClose} />
      <div
        className="keys-card chooser-card entry-card"
        role="dialog"
        aria-label={creating ? "New palette entry" : "Edit palette entry"}
      >
        <header>
          <strong>{creating ? "New palette entry" : "Edit palette entry"}</strong>
          <span />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="entry-fields">
          <label className="entry-name">
            Name
            <input
              value={name}
              aria-label="Name"
              // biome-ignore lint/a11y/noAutofocus: the dialog opens so the name can be typed
              autoFocus={creating}
              onFocus={(e) => {
                if (creating) e.currentTarget.select();
              }}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
          </label>
          <label className="entry-for">
            What it is for
            <input
              value={description}
              aria-label="What it is for"
              placeholder="A line on what this is for"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Colour
            <input
              type="color"
              aria-label="Fallback colour"
              title="How it draws when no block is chosen"
              value={tint}
              onChange={(e) => setTint(e.target.value)}
            />
          </label>
          <label className="look-glow">
            <input type="checkbox" checked={glow} onChange={(e) => setGlow(e.target.checked)} />
            Glows
          </label>
        </div>
        {error && <p className="palette-error">{error}</p>}
        <BlockChooser
          engine={engine}
          current={block}
          embedded
          searchAutoFocus={!creating}
          onExplore={setBlock}
        />
        <footer className="entry-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || name.trim() === ""}
            onClick={save}
          >
            {creating ? "Create" : "Save"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** "New", then "New 2", "New 3", … — the first name this palette doesn't already use. */
function freshName(palette: PaletteInfo): string {
  const names = new Set(palette.semantics.map((s) => s.name));
  if (!names.has("New")) return "New";
  let i = 2;
  while (names.has(`New ${i}`)) i++;
  return `New ${i}`;
}
