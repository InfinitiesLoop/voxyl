import { shapeName } from "@voxyl/shapes";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { download } from "../download.ts";
import type { Engine } from "../scene/Engine.ts";
import type { SchematicPlan, SchematicSource } from "../world/protocol.ts";
import { blockTitle } from "./BlockPicker.tsx";
import { useStore } from "./useStore.ts";

const WHAT: Record<"selection" | "build" | "prefab", string> = {
  selection: "the selection",
  build: "the whole build",
  prefab: "the prefab",
};

/**
 * "Export as a schematic": what Minecraft would get from a piece (the selection, the whole
 * build or a prefab) as a Schematica file. Semantics become blocks only here, at the moment of
 * export; each semantic can be ticked in or out, and what can't be written (no block chosen yet,
 * a block with no Minecraft identity, a shape the mods lack) is listed, never guessed. Opens
 * from the selection's Actions and from the Project dialog.
 */
export function SchematicDialog({ engine }: { engine: Engine }) {
  const source = useStore(engine.schematicDialog);
  if (!source) return null;
  return <Body engine={engine} source={source} />;
}

function Body({ engine, source }: { engine: Engine; source: SchematicSource }) {
  const close = () => engine.schematicDialog.set(null);
  const [exclude, setExclude] = useState<ReadonlySet<number>>(new Set());
  const [trim, setTrim] = useState(true);
  const [plan, setPlan] = useState<SchematicPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const excluded = useMemo(() => [...exclude].sort((a, b) => a - b), [exclude]);
  const kind = typeof source === "string" ? source : "prefab";

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      engine.schematicDialog.set(null);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [engine]);

  useEffect(() => {
    let cancel = false;
    setError(null);
    void engine.world.request({ type: "schematicPlan", source, exclude: excluded, trim }).then(
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
  }, [engine, source, excluded, trim]);

  const report = plan?.report;
  const save = () => {
    setBusy(true);
    setError(null);
    void engine.world.request({ type: "schematicFile", source, exclude: excluded, trim }).then(
      (file) => {
        const name = `${file.name.replace(/[^\w .-]+/g, "").trim() || "voxyl"}.schematic`;
        download(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), name);
        engine.say(`Exported ${name}.`);
        close();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  };
  const toggle = (semantic: number) =>
    setExclude((now) => {
      const next = new Set(now);
      if (!next.delete(semantic)) next.add(semantic);
      return next;
    });
  const warnings: string[] = [];
  if (report) {
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
  }

  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={close} />
      <div className="keys-card schematic" role="dialog" aria-label="Export as a schematic">
        <header>
          <strong>Export as a schematic</strong>
          <span>A Schematica file of {WHAT[kind]}, for Minecraft</span>
          <button type="button" onClick={close}>
            Close
          </button>
        </header>
        {error && <p className="palette-error">{error}</p>}
        {!plan && !error && <p className="home-sub">Reading what it holds…</p>}
        {plan && report && (
          <>
            <p className="home-sub">
              {report.problem ??
                (report.cellsWritten === 0
                  ? "Nothing can be written yet: choose a block for the semantics (the palette's Semantics list), or tick one that has a Minecraft block."
                  : `${report.size.join(" × ")} cells, ${report.cellsWritten.toLocaleString()} written in ${report.distinctBlocks.toLocaleString()} kinds of block${report.tileEntities > 0 ? `, ${report.tileEntities.toLocaleString()} of them parts` : ""}. Each semantic becomes the block its look names, only in the file; the build is not touched.`)}
            </p>
            <div className="schematic-semantics">
              {plan.semantics.map((row) => {
                const left = exclude.has(row.semantic);
                const note =
                  row.status === "undecided"
                    ? "no block chosen yet: left out"
                    : row.status === "unmapped"
                      ? "no Minecraft block known for it: left out"
                      : row.block
                        ? blockTitle(row.block)
                        : "";
                return (
                  <label
                    key={row.semantic}
                    className={row.status === "ok" ? undefined : "schematic-problem"}
                  >
                    <input type="checkbox" checked={!left} onChange={() => toggle(row.semantic)} />
                    <strong>{row.name}</strong>
                    <span>{row.count.toLocaleString()}</span>
                    <em>{note}</em>
                  </label>
                );
              })}
            </div>
            <label className="schematic-trim">
              <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
              Shrink the box to what is kept
            </label>
            {warnings.length > 0 && (
              <ul className="schematic-warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="schematic-list">
              <button type="button" aria-expanded={listing} onClick={() => setListing(!listing)}>
                {listing ? "Hide" : "Show"} the material list ({plan.materials.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(plan.materialText);
                  engine.say("Copied the material list.");
                }}
              >
                Copy it
              </button>
            </div>
            {listing && <pre className="schematic-materials">{plan.materialText}</pre>}
          </>
        )}
        <footer className="entry-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              busy || !plan || plan.report.problem !== null || plan.report.cellsWritten === 0
            }
            onClick={save}
          >
            Export
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
