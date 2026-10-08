import { blockLabel } from "@voxyl/blocks";
import { useEffect, useState } from "react";
import type { Engine } from "../scene/Engine.ts";
import type { BlockSearch } from "../world/protocol.ts";

/** "voxyl:oak_stairs" as "Oak stairs"; another library keeps its name. */
export function blockTitle(ref: string): string {
  const colon = ref.indexOf(":");
  const library = colon > 0 ? ref.slice(0, colon) : "";
  const name = blockLabel(ref);
  return library === "" || library === "voxyl" ? name : `${name} · ${library}`;
}

const ICON = 16 * 16 * 4;

/**
 * Finds blocks in the libraries in this browser, with a 16×16 icon each. `onPick` gets a block,
 * or null for "No block" (left out when `undecided` is false: browsing only).
 */
export function BlockPicker({
  engine,
  onPick,
  undecided = true,
}: {
  engine: Engine;
  onPick: (ref: string | null) => void;
  undecided?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("");
  const [pending, setPending] = useState("");
  const [result, setResult] = useState<BlockSearch | null>(null);
  useEffect(() => {
    const handle = setTimeout(() => setPending(query), 120);
    return () => clearTimeout(handle);
  }, [query]);
  useEffect(() => {
    let cancel = false;
    void engine.world
      .request({
        type: "findBlocks",
        query: pending,
        ...(library !== "" && { library }),
      })
      .then((found) => {
        if (!cancel) setResult(found);
      })
      .catch((caught: unknown) => {
        if (!cancel) console.error(caught);
      });
    return () => {
      cancel = true;
    };
  }, [engine, pending, library]);
  return (
    <div className="block-picker">
      <input
        value={query}
        placeholder="Search blocks"
        aria-label="Search blocks"
        onChange={(e) => setQuery(e.target.value)}
      />
      <select aria-label="Library" value={library} onChange={(e) => setLibrary(e.target.value)}>
        <option value="">All libraries</option>
        {(result?.libraries ?? []).map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      {undecided && (
        <button type="button" className="undecided" onClick={() => onPick(null)}>
          No block
        </button>
      )}
      {result && result.matched > result.hits.length && (
        <p className="palette-note">
          Showing {result.hits.length} of {result.matched}. Keep typing.
        </p>
      )}
      <div className="block-grid">
        {result?.hits.map((hit, i) => (
          <button
            key={hit.ref}
            type="button"
            className="block-choice"
            title={hit.ref}
            onClick={() => onPick(hit.ref)}
          >
            <BlockIcon icons={result.icons} index={i} color={hit.color} />
            <span>{hit.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function BlockIcon({
  icons,
  index,
  color,
}: {
  icons: Uint8Array;
  index: number;
  color: string;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const slice = icons.subarray(index * ICON, index * ICON + ICON);
    let textured = false;
    for (let i = 3; i < slice.length; i += 4) {
      if (slice[i] !== 0) {
        textured = true;
        break;
      }
    }
    if (!textured || slice.length < ICON) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 16, 16);
      return;
    }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(slice), 16, 16), 0, 0);
  }, [canvas, icons, index, color]);
  return <canvas ref={setCanvas} width={16} height={16} className="block-icon" />;
}
