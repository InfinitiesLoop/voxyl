import { ROOT_PALETTE, type SemanticArg } from "@voxyl/core";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo } from "../world/editing.ts";
import type { SelectionRow, SelectionView } from "../world/protocol.ts";
import { useStore } from "./useStore.ts";

interface ActionContext {
  readonly engine: Engine;
  readonly selection: SelectionView;
  readonly slotName: string | null;
}

interface SelectionAction {
  readonly id: string;
  readonly label: (ctx: ActionContext) => string;
  readonly title: string;
  readonly enabled: (ctx: ActionContext) => boolean;
  readonly run: (ctx: ActionContext) => void;
}

/**
 * Things to do to the cells in the selection. Add one here when a new operation arrives;
 * the selection panel stays about the shape of the region.
 */
const ACTIONS: readonly SelectionAction[] = [
  {
    id: "copy",
    label: () => "Copy",
    title:
      "Copy the selection to the clipboard (Ctrl+C). Ctrl+V then pastes it with the Paste tool.",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => void ctx.engine.copySelection(false),
  },
  {
    id: "cut",
    label: () => "Cut",
    title: "Copy the selection, then empty its cells (Ctrl+X).",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => void ctx.engine.copySelection(true),
  },
  {
    id: "cut-away",
    label: () => "Cut away this region",
    title:
      "Hide these cells in the 3D views so you can see and build inside. The cells are not touched.",
    enabled: (ctx) => ctx.selection.cells > 0,
    run: (ctx) => ctx.engine.cutAwaySelection(),
  },
  {
    id: "isolate",
    label: (ctx) => (ctx.engine.isolate.get() ? "Show everything" : "Show only the selection"),
    title:
      "Hide every cell outside the selection's box in the 3D views, to check exactly what is selected.",
    enabled: (ctx) => ctx.selection.cells > 0,
    run: (ctx) => ctx.engine.setIsolate(!ctx.engine.isolate.get()),
  },
  {
    id: "prefab",
    label: () => "Save as prefab…",
    title: "Keep the selection as a prefab: a named piece you can paste into any build (Ctrl+P).",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => ctx.engine.prefabDialog.set(true),
  },
  {
    id: "fill",
    label: (ctx) => (ctx.slotName ? `Fill with ${ctx.slotName}` : "Fill"),
    title: "Write the hotbar semantic into every selected cell.",
    enabled: (ctx) => ctx.slotName !== null && ctx.selection.cells > 0,
    run: (ctx) => ctx.engine.fillSelection(),
  },
  {
    id: "replace",
    label: (ctx) => (ctx.slotName ? `Replace with ${ctx.slotName}` : "Replace"),
    title: "Turn occupied cells into whole blocks of the hotbar semantic. Empty cells stay empty.",
    enabled: (ctx) => ctx.slotName !== null && ctx.selection.occupied > 0,
    run: (ctx) => ctx.engine.replaceSelection(),
  },
  {
    id: "clear",
    label: () => "Clear",
    title: "Empty the selected cells. Backspace does this too, with Select or Wand in hand.",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => ctx.engine.clearSelection(),
  },
];

/** A menu of operations on the current selection. Hidden until something is selected. */
export function SelectionActions({ engine }: { engine: Engine }) {
  const selection = useStore(engine.selection);
  const notice = useStore(engine.notice);
  const hotbar = useStore(engine.hotbar.state);
  const palettes = useStore(engine.palettes);
  // The isolate label follows this, so the menu redraws when it changes.
  useStore(engine.isolate);
  const [open, setOpen] = useState(false);
  const slot = hotbar.slots[hotbar.selected] ?? null;
  const ctx: ActionContext = {
    engine,
    selection,
    slotName: slot?.name ?? null,
  };

  if (selection.cells === 0) return null;

  const click = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    action();
    event.currentTarget.blur();
  };

  return (
    <div className="actions-menu">
      <button type="button" aria-expanded={open} onClick={click(() => setOpen((value) => !value))}>
        Actions
      </button>
      {open && (
        <div className="actions-panel">
          {ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={!action.enabled(ctx)}
              title={action.title}
              onClick={click(() => action.run(ctx))}
            >
              {action.label(ctx)}
            </button>
          ))}
          <Resemantic engine={engine} selection={selection} palettes={palettes} slot={slot} />
          {notice !== "" && <p className="selection-notice">{notice}</p>}
        </div>
      )}
    </div>
  );
}

interface Option {
  readonly key: string;
  readonly ref: SemanticArg;
  readonly label: string;
}

/** Switch one semantic for another, keeping each cell's shape. Its own form, not a button. */
function Resemantic({
  engine,
  selection,
  palettes,
  slot,
}: {
  engine: Engine;
  selection: SelectionView;
  palettes: readonly PaletteInfo[];
  slot: { ref: SemanticArg; name: string } | null;
}) {
  const fromOptions = useMemo(() => semanticOptions(selection.semantics), [selection.semantics]);
  const toOptions = useMemo(() => paletteOptions(palettes), [palettes]);
  const [fromKey, setFromKey] = useState("");
  const [toKey, setToKey] = useState("");

  useEffect(() => {
    if (!fromOptions.some((option) => option.key === fromKey))
      setFromKey(fromOptions[0]?.key ?? "");
  }, [fromOptions, fromKey]);

  useEffect(() => {
    if (toOptions.some((option) => option.key === toKey)) return;
    const match = slot ? toOptions.find((option) => sameRef(option.ref, slot.ref)) : undefined;
    setToKey(match?.key ?? toOptions[0]?.key ?? "");
  }, [toOptions, toKey, slot]);

  if (selection.occupied === 0 || fromOptions.length === 0 || toOptions.length === 0) return null;
  const from = fromOptions.find((option) => option.key === fromKey);
  const to = toOptions.find((option) => option.key === toKey);

  return (
    <div className="resemantic">
      <span>Re-semantic</span>
      <select
        aria-label="From"
        value={fromKey}
        onChange={(event) => setFromKey(event.target.value)}
      >
        {fromOptions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="resemantic-to">
        <span>to</span>
        <select aria-label="To" value={toKey} onChange={(event) => setToKey(event.target.value)}>
          {toOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={!from || !to || sameRef(from.ref, to.ref)}
        title="Switch one semantic for another, keeping each cell's shape"
        onClick={() => {
          if (from && to) engine.resemanticSelection(from.ref, to.ref);
        }}
      >
        Apply
      </button>
    </div>
  );
}

function semanticOptions(rows: readonly SelectionRow[]): Option[] {
  const seen = new Map<number, Option & { count: number }>();
  for (const row of rows) {
    const prev = seen.get(row.semantic);
    if (prev && prev.count >= row.count) continue;
    seen.set(row.semantic, {
      key: `#${row.semantic}`,
      ref: row.semantic,
      label: row.name,
      count: row.count,
    });
  }
  return [...seen.values()];
}

function paletteOptions(palettes: readonly PaletteInfo[]): Option[] {
  const many = palettes.length > 1;
  return palettes.flatMap((palette) =>
    palette.semantics.map((semantic) => ({
      key: refKey(semantic.ref),
      ref: semantic.ref,
      label:
        many && palette.id !== ROOT_PALETTE ? `${palette.name} · ${semantic.name}` : semantic.name,
    })),
  );
}

function refKey(ref: SemanticArg): string {
  return typeof ref === "number" ? `#${ref}` : `${ref.palette}:${ref.base}`;
}

function sameRef(a: SemanticArg, b: SemanticArg): boolean {
  if (typeof a === "number" || typeof b === "number") return a === b;
  return a.palette === b.palette && a.base === b.base;
}
