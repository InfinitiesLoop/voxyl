import { ROOT_PALETTE, type SemanticArg } from "@voxyl/core";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { PaletteInfo } from "../world/editing.ts";
import type { SelectionRow, SelectionView } from "../world/protocol.ts";
import { ActionIcon, type ActionIconId } from "./action-icons.tsx";
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
  /** Actions with an icon sit on the selection panel's toolbar; the rest are under "Actions". */
  readonly icon?: ActionIconId;
  readonly enabled: (ctx: ActionContext) => boolean;
  readonly run: (ctx: ActionContext) => void;
}

/**
 * Things to do to the cells in the selection. Add one here when a new operation arrives; the
 * selection panel shows the ones with an icon along its top and keeps the rest in a list.
 */
const ACTIONS: readonly SelectionAction[] = [
  {
    id: "cut",
    icon: "cut",
    label: () => "Cut",
    title: "Cut: copy the selection to the clipboard, then empty its cells (Ctrl+X).",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => void ctx.engine.copySelection(true),
  },
  {
    id: "copy",
    icon: "copy",
    label: () => "Copy",
    title:
      "Copy the selection to the clipboard (Ctrl+C). Ctrl+V then pastes it with the Paste tool.",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => void ctx.engine.copySelection(false),
  },
  {
    id: "prefab",
    icon: "prefab",
    label: () => "Save as prefab",
    title:
      "Save as prefab: keep the selection as a named piece you can paste into any build (Ctrl+P).",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => ctx.engine.regionDialog.set({ kind: "prefab" }),
  },
  {
    id: "schematic",
    icon: "schematic",
    label: () => "Export schematic",
    title:
      "Export as a schematic: write the selection as a Schematica file for Minecraft. Semantics become the blocks their looks name, only in the file.",
    enabled: (ctx) => ctx.selection.occupied > 0,
    run: (ctx) => ctx.engine.regionDialog.set({ kind: "schematic", source: "selection" }),
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

function useActionContext(engine: Engine): ActionContext {
  const selection = useStore(engine.selection);
  const hotbar = useStore(engine.hotbar.state);
  // The isolate label follows this, so the list redraws when it changes.
  useStore(engine.isolate);
  const slot = hotbar.slots[hotbar.selected] ?? null;
  return { engine, selection, slotName: slot?.name ?? null };
}

const click = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
  action();
  event.currentTarget.blur();
};

/** Cut, copy, save as prefab and export as a schematic: icons, with the description as the tooltip. */
export function SelectionToolbar({ engine }: { engine: Engine }) {
  const ctx = useActionContext(engine);
  return (
    <div className="selection-toolbar" role="toolbar" aria-label="Selection">
      {ACTIONS.filter((action) => action.icon).map((action) => (
        <button
          key={action.id}
          type="button"
          className="selection-tool"
          aria-label={action.label(ctx)}
          disabled={!action.enabled(ctx)}
          title={action.title}
          onClick={click(() => action.run(ctx))}
        >
          {action.icon && <ActionIcon id={action.icon} />}
        </button>
      ))}
    </div>
  );
}

/** The rest of what can be done to the selection, folded away until asked for. */
export function SelectionActions({ engine }: { engine: Engine }) {
  const ctx = useActionContext(engine);
  const palettes = useStore(engine.palettes);
  const hotbar = useStore(engine.hotbar.state);
  const [open, setOpen] = useState(false);
  const slot = hotbar.slots[hotbar.selected] ?? null;
  return (
    <div className="selection-more">
      <button
        type="button"
        className="selection-more-toggle"
        aria-expanded={open}
        onClick={click(() => setOpen((value) => !value))}
      >
        {open ? "▾" : "▸"} More actions
      </button>
      {open && (
        <div className="selection-more-list">
          {ACTIONS.filter((action) => !action.icon).map((action) => (
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
          <Resemantic engine={engine} selection={ctx.selection} palettes={palettes} slot={slot} />
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
