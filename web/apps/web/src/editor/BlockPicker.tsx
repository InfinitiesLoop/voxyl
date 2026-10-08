import { blockLabel } from "@voxyl/blocks";
import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
type Layout = "1x1" | "1x3" | "3x3";

/**
 * The block chooser, after the Godot app's: the libraries down the left (all of them, or
 * one), a search and a grid of icons, and on the right a turning preview of the block you
 * explore, alone, three in a row or a 3×3 wall to see how it tiles. A click explores;
 * "Use this block" (or a double-click) picks. In `browse` mode nothing is picked.
 */
export function BlockChooser({
  engine,
  current,
  onPick,
  browse = false,
}: {
  engine: Engine;
  /** The block the look has now, explored first. */
  current?: string | null;
  onPick?: (ref: string | null) => void;
  browse?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("");
  const [pending, setPending] = useState("");
  const [result, setResult] = useState<BlockSearch | null>(null);
  const [explored, setExplored] = useState<string | null>(current ?? null);
  const [layout, setLayout] = useState<Layout>("1x1");
  useEffect(() => {
    const handle = setTimeout(() => setPending(query), 120);
    return () => clearTimeout(handle);
  }, [query]);
  useEffect(() => {
    let cancel = false;
    void engine.world
      .request({ type: "findBlocks", query: pending, ...(library !== "" && { library }) })
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
    <div className="chooser">
      <nav className="chooser-rail" aria-label="Libraries">
        {[{ id: "", name: "All blocks" }, ...(result?.libraries ?? [])].map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={library === l.id}
            onClick={() => setLibrary(l.id)}
          >
            {l.name}
          </button>
        ))}
      </nav>
      <div className="chooser-main">
        <input
          className="chooser-search"
          value={query}
          placeholder="Search blocks"
          aria-label="Search blocks"
          // biome-ignore lint/a11y/noAutofocus: the chooser opens to search
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
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
              aria-pressed={hit.ref === explored}
              title={hit.ref}
              onClick={() => setExplored(hit.ref)}
              onDoubleClick={() => !browse && onPick?.(hit.ref)}
            >
              <BlockIcon icons={result.icons} index={i} color={hit.color} />
              <span>{hit.name}</span>
            </button>
          ))}
        </div>
      </div>
      <aside className="chooser-side">
        {explored ? (
          <>
            <BlockPreview engine={engine} block={explored} layout={layout} />
            <span className="chooser-layouts">
              {(["1x1", "1x3", "3x3"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={layout === l}
                  onClick={() => setLayout(l)}
                >
                  {l.replace("x", "×")}
                </button>
              ))}
            </span>
            <strong>{blockTitle(explored)}</strong>
            <small className="home-sub">{explored}</small>
          </>
        ) : (
          <p className="home-quiet">Click a block to see it turn.</p>
        )}
        {!browse && (
          <span className="chooser-commit">
            <button
              type="button"
              className="primary"
              disabled={!explored}
              onClick={() => explored && onPick?.(explored)}
            >
              Use this block
            </button>
            <button type="button" onClick={() => onPick?.(null)}>
              No block (undecided)
            </button>
          </span>
        )}
      </aside>
    </div>
  );
}

/** The chooser in a dialog over everything: the palette drawer and Home use it to pick. */
export function BlockChooserDialog({
  engine,
  title,
  current,
  onPick,
  onClose,
}: {
  engine: Engine;
  title: string;
  current?: string | null;
  onPick: (ref: string | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  // Over the whole page, whatever opened it (the drawer would clip it and scroll sideways).
  return createPortal(
    <div className="keys">
      <button type="button" className="keys-backdrop" aria-label="Close" onClick={onClose} />
      <div className="keys-card chooser-card" role="dialog" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <span />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <BlockChooser
          engine={engine}
          current={current ?? null}
          onPick={(ref) => {
            onPick(ref);
            onClose();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

/** Where each cube of a layout sits, in cubes. */
const LAYOUTS: Record<Layout, readonly (readonly [number, number])[]> = {
  "1x1": [[0, 0]],
  "1x3": [
    [-1, 0],
    [0, 0],
    [1, 0],
  ],
  "3x3": [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y] as const)),
};

/** CSS transforms putting each face (mesher order +X, -X, +Y, -Y, +Z, -Z) on a cube. */
const FACE_TRANSFORMS = [
  "rotateY(90deg)",
  "rotateY(-90deg)",
  "rotateX(90deg)",
  "rotateX(-90deg)",
  "rotateY(0deg)",
  "rotateY(180deg)",
];

/**
 * A turning preview of a block from its six face textures, drawn with CSS 3D (no second
 * renderer). A block that isn't a whole cube shows its side textures on a cube.
 */
function BlockPreview({
  engine,
  block,
  layout,
}: {
  engine: Engine;
  block: string;
  layout: Layout;
}) {
  const [faces, setFaces] = useState<(string | null)[] | null>(null);
  const [color, setColor] = useState("#808080");
  useEffect(() => {
    let cancel = false;
    void engine.world.request({ type: "blockPreview", ref: block }).then((preview) => {
      if (cancel || !preview) return;
      setColor(preview.color);
      setFaces(Array.from({ length: 6 }, (_, f) => faceUrl(preview.faces, f)));
    });
    return () => {
      cancel = true;
    };
  }, [engine, block]);
  const size = layout === "3x3" ? 40 : layout === "1x3" ? 44 : 72;
  return (
    <div className="cube-stage" style={{ "--cube": `${size}px` } as CSSProperties}>
      <div className="cube-spin">
        {LAYOUTS[layout].map(([x, y]) => (
          <div
            key={`${x},${y}`}
            className="cube"
            style={{ transform: `translate3d(${x * size}px, ${-y * size}px, 0)` }}
          >
            {FACE_TRANSFORMS.map((t, f) => (
              <div
                key={t}
                className="cube-face"
                style={{
                  transform: `${t} translateZ(${size / 2}px)`,
                  background: faces?.[f] ? `url(${faces[f]}) center / 100% 100%` : color,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One face's 16×16 pixels as a PNG data URL, or null where the face has none. */
function faceUrl(faces: Uint8Array, f: number): string | null {
  const slice = faces.subarray(f * ICON, f * ICON + ICON);
  if (!slice.some((v, i) => i % 4 === 3 && v !== 0)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(slice), 16, 16), 0, 0);
  return canvas.toDataURL();
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
