import type { Form, Look } from "@voxyl/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import {
  type PaletteInfo,
  PLACEMENT_CHOICES,
  placementName,
  placementOf,
  type SemanticInfo,
} from "../world/editing.ts";
import { BlockChooser } from "./BlockPicker.tsx";
import { ShapePicker } from "./ShapePicker.tsx";

/** What the entry editor produces: the same whichever palette (a build's or a shared one) it is for. */
export interface EntryValue {
  readonly name: string;
  readonly description: string;
  readonly look: Look;
  readonly form: Form;
}

/**
 * New or edit a palette entry, the way the Godot app does: a name (already filled in) and
 * the block chooser, so the block is picked here rather than asked for first. Nothing is
 * written until Create or Save. Which palette it is for is the caller's: `onSave` takes the
 * result and rejects with a reason to show.
 */
export function EntryDialog({
  engine,
  creating,
  initial,
  inheritsShape = false,
  note,
  onSave,
  onDelete,
  onClose,
}: {
  engine: Engine;
  creating: boolean;
  initial: {
    name: string;
    description: string;
    block: string | null;
    glow: boolean;
    tint: string;
    shape: string | null;
    placement: string;
  };
  /** The shape is inherited from another palette's semantic, which forms only merge with. */
  inheritsShape?: boolean;
  note?: string;
  onSave: (value: EntryValue) => Promise<unknown>;
  /** Offered when editing: removes the entry. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [block, setBlock] = useState<string | null>(initial.block);
  const [glow, setGlow] = useState(initial.glow);
  const [tint, setTint] = useState(initial.tint);
  const [shape, setShape] = useState<string | null>(initial.shape);
  const [placement, setPlacement] = useState(initial.placement);
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
    // The form this semantic sets itself: the shape, or how whole blocks turn.
    const profile = shape === null && placement !== "auto" ? placementOf(placement) : undefined;
    const form: Form = { ...(shape ? { shape } : {}), ...(profile ? { placement: profile } : {}) };
    setBusy(true);
    void onSave({ name: trimmed, description: description.trim(), look, form }).then(
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
          <div className="entry-shape">
            <span>Shape</span>
            <ShapePicker shape={shape} onChange={setShape} wholeBlockLocked={inheritsShape} />
          </div>
          {shape === null && (
            <label>
              Placing
              <select
                aria-label="Placing"
                title="How whole blocks of this turn when placed. By default, as the block it looks like does."
                value={placement}
                onChange={(e) => setPlacement(e.target.value)}
              >
                {PLACEMENT_CHOICES.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
                {placement === "custom" && <option value="custom">Custom</option>}
              </select>
            </label>
          )}
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
        {note && <p className="palette-note">{note}</p>}
        {error && <p className="palette-error">{error}</p>}
        <BlockChooser
          engine={engine}
          current={block}
          embedded
          searchAutoFocus={!creating}
          onExplore={setBlock}
        />
        <footer className="entry-actions">
          {onDelete && !creating && (
            <button type="button" onClick={onDelete}>
              Delete
            </button>
          )}
          <span className="topbar-gap" />
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

/** New or edit an entry of a build's palette. */
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
  // A semantic that derives from another keeps the shape it inherits: forms only merge.
  const inheritsShape =
    semantic?.base !== undefined &&
    semantic.shape !== undefined &&
    semantic.ownForm.shape === undefined;
  return (
    <EntryDialog
      engine={engine}
      creating={semantic === null}
      initial={{
        name: semantic?.name ?? freshName(palette.semantics.map((s) => s.name)),
        description: semantic?.description ?? "",
        block: semantic?.block ?? null,
        glow: semantic?.glow ?? false,
        tint: semantic?.ownLook.tint ?? semantic?.color ?? "#9aa0a8",
        shape: semantic?.shape ?? null,
        placement: semantic?.placement ?? "auto",
      }}
      inheritsShape={inheritsShape}
      {...(semantic?.base !== undefined && {
        note: "This semantic comes from another palette. A new name here is this palette's own; to rename it everywhere, use Semantics.",
      })}
      onSave={({ name, description, look, form }) => {
        if (!semantic) {
          return engine.world.request({
            type: "addSemantic",
            palette: palette.id,
            name,
            ...(description !== "" && { description }),
            look,
            ...(Object.keys(form).length > 0 && { form }),
          });
        }
        const formChanged =
          (semantic.shape ?? null) !== (form.shape ?? null) ||
          (form.shape === undefined && semantic.placement !== placementName(form.placement));
        return engine.world.request({
          type: "editSemantic",
          semantic: semantic.ref,
          name,
          description,
          look,
          ...(formChanged && { form: Object.keys(form).length > 0 ? form : null }),
        });
      }}
      onClose={onClose}
    />
  );
}

/** "New", then "New 2", "New 3", … — the first name that isn't taken. */
export function freshName(taken: readonly string[]): string {
  const names = new Set(taken);
  if (!names.has("New")) return "New";
  let i = 2;
  while (names.has(`New ${i}`)) i++;
  return `New ${i}`;
}
