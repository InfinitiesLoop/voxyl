import { shapeName } from "@voxyl/shapes";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { download } from "../download.ts";
import type { Engine, RegionDialogState } from "../scene/Engine.ts";
import type { RegionPlan, RegionSemantic, SchematicSource } from "../world/protocol.ts";
import { blockTitle } from "./BlockPicker.tsx";
import { type IncludeRow, Manifest } from "./Manifest.tsx";
import { PiecePreview } from "./PiecePreview.tsx";
import { usePrefabs } from "./prefabs.tsx";
import { useStore } from "./useStore.ts";

type Kind = RegionDialogState["kind"];

const WHAT = {
  selection: "the selection",
  build: "the whole build",
  prefab: "the prefab",
} as const;

/**
 * Where a region is taken apart before it goes somewhere: the selection to keep as a prefab,
 * the selection, the whole build or a prefab to write as a schematic, or a saved prefab to
 * look at. All three show the same thing: what would be kept turning on the right, what it
 * holds as the same Semantics / Blocks list the selection panel has, a tick per semantic to
 * leave it out and a trim for the box. Only the fields and the last step differ.
 *
 * Semantics become blocks only in a schematic file, at the moment of export; what cannot be
 * written (no block chosen yet, a block with no Minecraft identity, a shape the mods lack) is
 * listed, never guessed (principles 1 and 3).
 */
export function RegionDialog({ engine }: { engine: Engine }) {
  const state = useStore(engine.regionDialog);
  if (!state) return null;
  return <Body key={JSON.stringify(state)} engine={engine} state={state} />;
}

function sourceOf(state: RegionDialogState): SchematicSource {
  if (state.kind === "prefab") return "selection";
  if (state.kind === "schematic") return state.source;
  return { prefab: state.id };
}

function Body({ engine, state }: { engine: Engine; state: RegionDialogState }) {
  const kind: Kind = state.kind;
  const source = useMemo(() => sourceOf(state), [state]);
  const close = () => engine.regionDialog.set(null);
  const prefabs = usePrefabs(engine);
  const entry = state.kind === "details" ? prefabs.find((item) => item.id === state.id) : undefined;

  const [exclude, setExclude] = useState<ReadonlySet<number>>(new Set());
  const [trimChoice, setTrimChoice] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<RegionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [tags, setTags] = useState("");
  const [handle, setHandle] = useState<"bottom-center" | "bottom-corner">("bottom-center");
  const excluded = useMemo(() => [...exclude].sort((a, b) => a - b), [exclude]);
  // Leaving something out turns trimming on, until it is set by hand (so a pillar without its
  // floor doesn't float a block up).
  const trim = trimChoice ?? exclude.size > 0;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      engine.regionDialog.set(null);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [engine]);

  useEffect(() => {
    let cancel = false;
    setError(null);
    void engine.world
      .request({
        type: "regionPlan",
        source,
        exclude: excluded,
        trim,
        schematic: kind === "schematic",
      })
      .then(
        (next) => {
          if (!cancel) setPlan(next);
        },
        (caught: unknown) => {
          if (!cancel) setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
    return () => {
      cancel = true;
    };
  }, [engine, source, excluded, trim, kind]);

  // A name to start from: "Prefab 1", or the next number that is free, until one is typed.
  const taken = (candidate: string) =>
    prefabs.some((item) => item.name.trim().toLowerCase() === candidate.trim().toLowerCase());
  let free = 1;
  while (taken(`Prefab ${free}`)) free++;
  const name = typedName ?? `Prefab ${free}`;
  const setName = setTypedName;

  const report = plan?.schematic?.report;
  const nothing = plan !== null && plan.cells === 0;
  const replaces = kind === "prefab" && name.trim() !== "" && taken(name);

  const toggle = (semantic: number) =>
    setExclude((now) => {
      const next = new Set(now);
      if (!next.delete(semantic)) next.add(semantic);
      return next;
    });
  const setAll = (on: boolean) =>
    setExclude(on || !plan ? new Set() : new Set(plan.semantics.map((row) => row.semantic)));

  const failed = (caught: unknown) => {
    setBusy(false);
    setError(caught instanceof Error ? caught.message : String(caught));
  };
  const savePrefab = () => {
    if (name.trim() === "" || nothing) return;
    setBusy(true);
    setError(null);
    void engine
      .savePrefab(name, tags.split(","), { exclude: excluded, trim, handle, replace: replaces })
      .then(close, failed);
  };
  const exportSchematic = () => {
    setBusy(true);
    setError(null);
    void engine.world
      .request({ type: "schematicFile", source, exclude: excluded, trim })
      .then((file) => {
        const fileName = `${file.name.replace(/[^\w .-]+/g, "").trim() || "voxyl"}.schematic`;
        download(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), fileName);
        engine.say(`Exported ${fileName}.`);
        close();
      }, failed);
  };

  const rows: IncludeRow[] = (plan?.semantics ?? []).map((row) => ({
    semantic: row.semantic,
    name: row.name,
    color: row.color,
    count: row.count,
    ...noteOf(row, kind === "schematic"),
  }));
  const warnings = report ? warningsOf(report) : [];
  const writable =
    kind !== "schematic" ||
    (report !== undefined && report.problem === null && report.cellsWritten > 0);
  const size = kind === "schematic" && report ? report.size : (plan?.size ?? [0, 0, 0]);
  const title =
    kind === "prefab"
      ? "Save as a prefab"
      : kind === "schematic"
        ? "Export as a schematic"
        : (entry?.name ?? "Prefab");
  const sub =
    kind === "prefab"
      ? "Keep the selection to paste into any build"
      : kind === "schematic"
        ? `A Schematica file of ${WHAT[typeof source === "string" ? source : "prefab"]}, for Minecraft`
        : "A saved prefab";

  const lead = !plan
    ? "Reading what it holds…"
    : kind === "schematic" && report
      ? (report.problem ??
        (report.cellsWritten === 0
          ? "Nothing can be written yet: choose a block for the semantics (the palette's Semantics list), or tick one that has a Minecraft block."
          : `${size.join(" × ")} cells, ${report.cellsWritten.toLocaleString()} written in ${report.distinctBlocks.toLocaleString()} kinds of block${report.tileEntities > 0 ? `, ${report.tileEntities.toLocaleString()} of them parts` : ""}. Each semantic becomes the block its look names, only in the file; the build is not touched.`))
      : `${size.join(" × ")} · ${plan.cells.toLocaleString()} blocks${kind === "prefab" ? ". A prefab pastes into any build, and takes the build's own look for each semantic it already has." : ""}`;

  const form = (
    <>
      <p className="home-sub">{lead}</p>
      {kind === "prefab" && (
        <>
          <label>
            Name
            <input
              value={name}
              aria-label="Name"
              // biome-ignore lint/a11y/noAutofocus: the dialog opens so the name can be typed
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Handle
            <select
              value={handle}
              aria-label="Handle"
              onChange={(e) => setHandle(e.target.value as typeof handle)}
            >
              <option value="bottom-center">Bottom center</option>
              <option value="bottom-corner">Bottom corner (min x, y, z)</option>
            </select>
            <small>The cell that lands on your aim when placing, and turns pivot about.</small>
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
        </>
      )}
      {kind === "details" && entry && entry.tags.length > 0 && (
        <p className="home-sub">{entry.tags.join(" · ")}</p>
      )}
      {plan && (
        <Manifest
          title={`${size.join(" × ")}`}
          semantics={rows}
          materials={plan.materials}
          {...(kind !== "details" && { include: { excluded: exclude, toggle, setAll } })}
          {...(plan.schematic && { blocksText: plan.schematic.materialText })}
          empty="Nothing in it."
        />
      )}
      {kind !== "details" && (
        <label className="schematic-trim" title="Drop empty rows left around the kept cells">
          <input type="checkbox" checked={trim} onChange={(e) => setTrimChoice(e.target.checked)} />
          Shrink the box to what is kept
        </label>
      )}
      {replaces && (
        <p className="schematic-warnings">
          A prefab named {name.trim()} exists — saving replaces it.
        </p>
      )}
      {nothing && kind === "prefab" && (
        <p className="schematic-warnings">Nothing is left to save.</p>
      )}
      {nothing && kind === "details" && <p className="home-sub">This prefab is empty.</p>}
      {warnings.length > 0 && (
        <ul className="schematic-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );

  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={close} />
      <form
        className="keys-card region"
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === "prefab") savePrefab();
        }}
      >
        <header>
          <strong>{title}</strong>
          <span>{sub}</span>
          <button type="button" onClick={close}>
            Close
          </button>
        </header>
        {error && <p className="palette-error">{error}</p>}
        <div className="region-body">
          <div className="region-form">{form}</div>
          <div className="region-view">
            <PiecePreview surface={plan?.surface ?? null} />
            <p className="region-caption">
              Preview of what will be kept · drag to turn, wheel to zoom
            </p>
          </div>
        </div>
        <footer className="entry-actions">
          {kind === "details" ? (
            <>
              <button type="button" onClick={close}>
                Close
              </button>
              <button
                type="button"
                disabled={!state || nothing}
                onClick={() => {
                  if (state.kind === "details")
                    engine.regionDialog.set({ kind: "schematic", source: { prefab: state.id } });
                }}
              >
                Export as a schematic…
              </button>
              <button
                type="button"
                className="primary"
                disabled={nothing}
                onClick={() => {
                  if (state.kind !== "details") return;
                  close();
                  void engine.pastePrefab(state.id);
                }}
              >
                Paste
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={close}>
                Cancel
              </button>
              {kind === "prefab" ? (
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !plan || nothing || name.trim() === ""}
                >
                  {replaces ? "Replace" : "Save"}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !plan || !writable}
                  onClick={exportSchematic}
                >
                  Export
                </button>
              )}
            </>
          )}
        </footer>
      </form>
    </div>,
    document.body,
  );
}

/** What a row says under its name: its parts, and in a schematic whether it can be written. */
function noteOf(
  row: RegionSemantic,
  schematic: boolean,
): { detail?: string; note?: string; problem?: boolean } {
  const shaped = Object.entries(row.parts)
    .map(([shape, n]) => `${shapeName(shape).toLowerCase()} ×${n.toLocaleString()}`)
    .join(", ");
  const parts = shaped === "" ? "" : row.blocks > 0 ? `${shaped} + whole` : shaped;
  if (!schematic) return parts === "" ? {} : { detail: parts };
  const status =
    row.status === "undecided"
      ? "no block chosen yet: left out"
      : row.status === "unmapped"
        ? "no Minecraft block known for it: left out"
        : row.block
          ? blockTitle(row.block)
          : "";
  const note = [parts, status].filter((part) => part !== "").join(" · ");
  return { ...(note !== "" && { note }), ...(row.status !== "ok" && { problem: true }) };
}

function warningsOf(report: NonNullable<RegionPlan["schematic"]>["report"]): string[] {
  const warnings: string[] = [];
  for (const [shape, n] of Object.entries(report.unsupported)) {
    warnings.push(
      `${n.toLocaleString()} ${shapeName(shape).toLowerCase()} part${n === 1 ? "" : "s"} have no equivalent in the mods and are left out.`,
    );
  }
  for (const [name, n] of Object.entries(report.sawWarnings)) {
    warnings.push(
      `${name}: ${n.toLocaleString()} microblock${n === 1 ? "" : "s"} are cut from a block the saw can't cut.`,
    );
  }
  const assumed = Object.keys(report.assumed);
  if (assumed.length > 0) {
    warnings.push(
      `Written from a best-guess Minecraft block, not a confirmed one: ${assumed.join(", ")}.`,
    );
  }
  if (report.turnedDegrees !== 0) {
    warnings.push(
      `Turned ${report.turnedDegrees}° so this build's north is the game's north (−Z).`,
    );
  }
  return warnings;
}
