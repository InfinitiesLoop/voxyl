import { type MouseEvent, type ReactNode, useState } from "react";
import type { SelectionRow } from "../world/protocol.ts";
import { countText, grouped, stacks } from "./counts.ts";

const MODE_KEY = "voxyl.countMode";

export type ManifestMode = "semantics" | "blocks";

/** Semantics or Blocks, remembered between the panels and dialogs that list contents. */
export function useManifestMode(): [ManifestMode, (mode: ManifestMode) => void] {
  const [mode, setMode] = useState<ManifestMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "blocks" ? "blocks" : "semantics";
    } catch {
      return "semantics";
    }
  });
  const choose = (next: ManifestMode) => {
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // The choice just isn't remembered.
    }
    setMode(next);
  };
  return [mode, choose];
}

/** A row that can be ticked in or out, for the dialogs that take part of a piece. */
export interface IncludeRow extends SelectionRow {
  /** Small grey text under the name, replacing `detail` when set (why a row is left out). */
  readonly note?: string;
  /** Draws the row as a problem (can't be written, say). */
  readonly problem?: boolean;
}

export interface Include {
  /** Semantic numbers that are left out. */
  readonly excluded: ReadonlySet<number>;
  readonly toggle: (semantic: number) => void;
  readonly setAll: (on: boolean) => void;
}

/**
 * What a region holds, listed two ways: by semantic and by the block each semantic's look
 * names. The selection panel, the prefab and schematic dialogs and a prefab's details all show
 * contents with this, so they read alike. With `include`, the Semantics tab gets a tick per
 * row to leave a semantic out.
 */
export function Manifest({
  title,
  semantics,
  materials,
  include,
  blocksText,
  empty,
  children,
}: {
  /** The first line of the copied list (the size, say). */
  title: string;
  semantics: readonly IncludeRow[];
  materials: readonly SelectionRow[];
  include?: Include;
  /** What Copy puts on the clipboard from the Blocks tab, when it isn't the rows as shown. */
  blocksText?: string;
  /** Said under an empty list. */
  empty?: string | undefined;
  /** Extra controls after Copy. */
  children?: ReactNode;
}) {
  const [mode, setMode] = useManifestMode();
  const [copied, setCopied] = useState(false);
  const rows = mode === "semantics" ? semantics : materials;
  const click = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    action();
    event.currentTarget.blur();
  };
  const choose = (next: ManifestMode) => {
    setMode(next);
    setCopied(false);
  };
  return (
    <div className="manifest">
      <div className="selection-mode">
        <button
          type="button"
          className={mode === "semantics" ? "active" : undefined}
          onClick={click(() => choose("semantics"))}
        >
          Semantics
        </button>
        <button
          type="button"
          className={mode === "blocks" ? "active" : undefined}
          onClick={click(() => choose("blocks"))}
        >
          Blocks
        </button>
        <button
          type="button"
          onClick={click(() => {
            const text = mode === "blocks" && blocksText ? blocksText : listText(title, rows);
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          })}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {include && mode === "semantics" && (
          <span className="manifest-all">
            <button type="button" onClick={click(() => include.setAll(true))}>
              All
            </button>
            <button type="button" onClick={click(() => include.setAll(false))}>
              None
            </button>
          </span>
        )}
        {children}
      </div>
      <div className="selection-scroll">
        {rows.map((row) => (
          <Row
            key={`${mode}:${row.semantic}:${row.name}:${row.detail ?? ""}`}
            row={row}
            include={mode === "semantics" ? include : undefined}
          />
        ))}
        {rows.length === 0 && empty && <p className="selection-lead">{empty}</p>}
      </div>
    </div>
  );
}

function Row({ row, include }: { row: IncludeRow; include: Include | undefined }) {
  const breakdown = stacks(row.count);
  const left = include?.excluded.has(row.semantic) === true;
  const body = (
    <>
      <span className="selection-swatch" style={{ background: row.color }} />
      <span className="selection-name">
        {row.name}
        {(row.note ?? row.detail) && (
          <small className={row.problem ? "row-problem" : undefined}>
            {row.note ?? row.detail}
          </small>
        )}
      </span>
      <span className="selection-count">
        {grouped(row.count)}
        {breakdown !== "" && <small>{breakdown}</small>}
      </span>
    </>
  );
  if (!include) return <div className="selection-row">{body}</div>;
  return (
    <label
      className={`selection-row include${left ? " left-out" : ""}${row.problem ? " problem" : ""}`}
    >
      <input
        type="checkbox"
        checked={!left}
        onChange={() => include.toggle(row.semantic)}
        aria-label={`Include ${row.name}`}
      />
      {body}
    </label>
  );
}

/** The manifest as plain text: the title, then one line per row with its count. */
export function listText(title: string, rows: readonly SelectionRow[]): string {
  const lines = [title];
  for (const row of rows) {
    const name = row.detail ? `${row.name} (${row.detail})` : row.name;
    lines.push(`${name}\t${countText(row.count)}`);
  }
  return lines.join("\n");
}
