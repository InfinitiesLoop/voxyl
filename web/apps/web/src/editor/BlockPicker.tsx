import { blockLabel } from "@voxyl/blocks";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine } from "../scene/Engine.ts";
import type { BlockSearch } from "../world/protocol.ts";
import { BakedIcon, PREVIEW_PX } from "./icons.tsx";
import {
  chooseOnly,
  filterLibraries,
  liveSelection,
  sortLibraries,
  toggleLibrary,
} from "./library-list.ts";
import { Store } from "./store.ts";
import { useTurntable } from "./turntable.ts";
import { useStore } from "./useStore.ts";

/** "voxyl:oak_stairs" as "Oak stairs"; another library keeps its name. */
export function blockTitle(ref: string): string {
  const colon = ref.indexOf(":");
  const library = colon > 0 ? ref.slice(0, colon) : "";
  const name = blockLabel(ref);
  return library === "" || library === "voxyl" ? name : `${name} · ${library}`;
}

const PAGE = 80;
type Layout = "1x1" | "1x3" | "3x3";
type BlockHit = BlockSearch["hits"][number];

/** The 1×1 / 1×3 / 3×3 choice, shared by the inventory and the block library. */
const previewLayout = new Store<Layout>("1x1");

/**
 * The libraries block search draws from; empty means all of them. View state shared by every
 * chooser, so what you pick on Home's Blocks tab also narrows the palette entry's picker.
 */
const chosenLibraries = new Store<ReadonlySet<string>>(new Set());

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
  onExplore,
  browse = false,
  embedded = false,
  searchAutoFocus = true,
  onImport,
  onRemoveMany,
  removable,
}: {
  engine: Engine;
  /** The block the look has now, explored first. */
  current?: string | null;
  onPick?: (ref: string | null) => void;
  /** Fires as the explored block changes. The palette entry editor saves that one. */
  onExplore?: (ref: string | null) => void;
  browse?: boolean;
  /** Inside the palette entry editor: picking explores, and the editor's own button saves. */
  embedded?: boolean;
  searchAutoFocus?: boolean;
  /** Home's Blocks tab: bring in Minecraft (a game folder or a jar), and drop a library. */
  onImport?: () => void;
  onRemoveMany?: (items: { id: string; name: string }[]) => void;
  removable?: ReadonlySet<string>;
}) {
  const [query, setQuery] = useState("");
  const chosen = useStore(chosenLibraries);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [pending, setPending] = useState("");
  const [libraries, setLibraries] = useState<BlockSearch["libraries"][number][]>([]);
  const [hits, setHits] = useState<BlockHit[]>([]);
  const [matched, setMatched] = useState(0);
  const [explored, setExplored] = useState<string | null>(current ?? null);
  const [settled, setSettled] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** The chosen libraries as a stable key and list for requests. */
  const chosenKey = [...chosen].sort().join(",");
  const generation = useRef(0);
  const loading = useRef(false);
  const more = useRef<() => void>(() => {});
  useEffect(() => {
    const handle = setTimeout(() => setPending(query), 120);
    return () => clearTimeout(handle);
  }, [query]);
  useEffect(() => {
    const gen = ++generation.current;
    loading.current = true;
    setHits([]);
    setMatched(0);
    setSettled(false);
    let cancel = false;
    void engine.world
      .request({
        type: "findBlocks",
        query: pending,
        limit: PAGE,
        offset: 0,
        ...(chosenKey !== "" && { libraries: chosenKey.split(",") }),
      })
      .then((found) => {
        if (cancel || generation.current !== gen) return;
        loading.current = false;
        setLibraries([...found.libraries]);
        // A library that was removed no longer narrows the search.
        const live = liveSelection(chosenLibraries.get(), found.libraries);
        if (live.size !== chosenLibraries.get().size) chosenLibraries.set(live);
        setMatched(found.matched);
        setHits([...found.hits]);
        setSettled(true);
      })
      .catch((caught: unknown) => {
        if (cancel || generation.current !== gen) return;
        loading.current = false;
        console.error(caught);
      });
    return () => {
      cancel = true;
    };
  }, [engine, pending, chosenKey]);
  more.current = () => {
    if (loading.current || hits.length === 0 || hits.length >= matched) return;
    const gen = generation.current;
    const offset = hits.length;
    loading.current = true;
    void engine.world
      .request({
        type: "findBlocks",
        query: pending,
        limit: PAGE,
        offset,
        ...(chosenKey !== "" && { libraries: chosenKey.split(",") }),
      })
      .then((found) => {
        if (generation.current !== gen) return;
        loading.current = false;
        setMatched(found.matched);
        setHits((prev) => [...prev, ...found.hits]);
      })
      .catch((caught: unknown) => {
        if (generation.current !== gen) return;
        loading.current = false;
        console.error(caught);
      });
  };
  useEffect(() => {
    const root = gridRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || hits.length === 0 || hits.length >= matched) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.current();
      },
      { root, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hits.length, matched]);
  const shownLibraries = filterLibraries(sortLibraries(libraries), libraryQuery);
  const doomed = libraries.filter((l) => chosen.has(l.id) && removable?.has(l.id));
  return (
    <div className="chooser">
      <nav className="chooser-rail" aria-label="Libraries">
        {onImport && (
          <button
            type="button"
            title="Textures from your own Minecraft stay in this browser"
            onClick={onImport}
          >
            Import Minecraft…
          </button>
        )}
        <input
          className="chooser-search"
          value={libraryQuery}
          placeholder="Search libraries"
          aria-label="Search libraries"
          onChange={(e) => setLibraryQuery(e.target.value)}
        />
        <div className="chooser-libs">
          <div className="chooser-lib">
            <button
              type="button"
              aria-pressed={chosen.size === 0}
              title="Search every library"
              onClick={() => chosenLibraries.set(new Set())}
            >
              All blocks
            </button>
          </div>
          {shownLibraries.map((l) => (
            <div key={l.id} className="chooser-lib">
              <input
                type="checkbox"
                checked={chosen.has(l.id)}
                aria-label={`Search ${l.name}`}
                title="Search this library (tick several to search them together)"
                onChange={() => chosenLibraries.set(toggleLibrary(chosen, l.id))}
              />
              <button
                type="button"
                aria-pressed={chosen.has(l.id)}
                title={l.name}
                onClick={(e) =>
                  chosenLibraries.set(
                    e.ctrlKey || e.metaKey || e.shiftKey
                      ? toggleLibrary(chosen, l.id)
                      : chooseOnly(chosen, l.id),
                  )
                }
              >
                {l.name}
              </button>
            </div>
          ))}
          {shownLibraries.length === 0 && <p className="home-quiet">No library matches.</p>}
        </div>
        {onRemoveMany && (
          <button
            type="button"
            className="chooser-delete"
            disabled={doomed.length === 0}
            title={
              doomed.length === 0
                ? "Tick libraries you imported to remove them"
                : `Remove ${doomed.map((l) => l.name).join(", ")} from this browser`
            }
            onClick={() => onRemoveMany(doomed)}
          >
            Delete selected{doomed.length > 0 ? ` (${doomed.length})` : ""}
          </button>
        )}
      </nav>
      <div className="chooser-main">
        <input
          className="chooser-search"
          value={query}
          placeholder="Search blocks"
          aria-label="Search blocks"
          // biome-ignore lint/a11y/noAutofocus: the chooser opens to search
          autoFocus={searchAutoFocus}
          onChange={(e) => setQuery(e.target.value)}
        />
        {matched > hits.length && (
          <p className="chooser-count">
            {hits.length} of {matched} blocks
          </p>
        )}
        <div className="block-grid" ref={gridRef}>
          {hits.map((hit) => (
            <button
              key={hit.ref}
              type="button"
              className="block-choice"
              aria-pressed={hit.ref === explored}
              title={hit.ref}
              onClick={() => {
                setExplored(hit.ref);
                onExplore?.(hit.ref);
              }}
              onDoubleClick={() => {
                if (embedded) onExplore?.(hit.ref);
                else if (!browse) onPick?.(hit.ref);
              }}
            >
              <BakedIcon engine={engine} block={hit.ref} color={hit.color} className="block-icon" />
              <span>{hit.name}</span>
            </button>
          ))}
          {hits.length < matched && <div ref={sentinelRef} className="block-sentinel" />}
        </div>
        {settled && hits.length === 0 && <p className="home-quiet">No blocks.</p>}
      </div>
      <aside className="chooser-side">
        {explored ? (
          <>
            <BlockStage engine={engine} block={explored} />
            <strong>{blockTitle(explored)}</strong>
            <small className="home-sub">{explored}</small>
          </>
        ) : (
          <p className="home-quiet">Click a block to see it turn.</p>
        )}
        {!browse && (
          <span className="chooser-commit">
            {!embedded && (
              <button
                type="button"
                className="primary"
                disabled={!explored}
                onClick={() => explored && onPick?.(explored)}
              >
                Use this block
              </button>
            )}
            {embedded && (
              <p className="palette-note">
                {explored ? blockTitle(explored) : "Undecided"} is what this entry places.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setExplored(null);
                onExplore?.(null);
                if (!embedded) onPick?.(null);
              }}
            >
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

/**
 * The turning preview and its 1×1, 1×3 and 3×3 choices. The inventory and the block
 * library both use it, and they share which layout is chosen.
 */
export function BlockStage({ engine, block }: { engine: Engine; block: string }) {
  const layout = useStore(previewLayout);
  const [whole, setWhole] = useState(true);
  return (
    <>
      <BlockPreview engine={engine} block={block} layout={layout} onCube={setWhole} />
      {whole && (
        <span className="chooser-layouts">
          {(["1x1", "1x3", "3x3"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={layout === l}
              onClick={() => previewLayout.set(l)}
            >
              {l.replace("x", "×")}
            </button>
          ))}
        </span>
      )}
    </>
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
 * A turning preview of a whole cube from its six face textures, drawn with CSS 3D (no second
 * renderer). Anything else is the baked picture of its real model.
 */
function BlockPreview({
  engine,
  block,
  layout,
  onCube,
}: {
  engine: Engine;
  block: string;
  layout: Layout;
  onCube: (cube: boolean) => void;
}) {
  const turn = useTurntable();
  const [faces, setFaces] = useState<(string | null)[] | null>(null);
  const [color, setColor] = useState("#808080");
  const [cube, setCube] = useState<boolean | null>(null);
  useEffect(() => {
    let cancel = false;
    setCube(null);
    void engine.world.request({ type: "blockPreview", ref: block }).then((preview) => {
      if (cancel || !preview) return;
      setColor(preview.color);
      setCube(preview.cube);
      onCube(preview.cube);
      setFaces(Array.from({ length: 6 }, (_, f) => faceUrl(preview.faces, preview.size, f)));
    });
    return () => {
      cancel = true;
    };
  }, [engine, block, onCube]);
  const size = layout === "3x3" ? 40 : layout === "1x3" ? 44 : 72;
  if (cube === false) {
    return (
      <BakedIcon
        engine={engine}
        block={block}
        color={color}
        size={PREVIEW_PX}
        className="chooser-bake"
      />
    );
  }
  return (
    <div
      className="cube-stage"
      title="Drag to turn"
      style={{ "--cube": `${size}px` } as CSSProperties}
      onPointerDown={turn.onPointerDown}
      onPointerMove={turn.onPointerMove}
      onPointerUp={turn.onPointerUp}
      onPointerCancel={turn.onPointerCancel}
    >
      <div className="cube-spin" ref={turn.ref}>
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
function faceUrl(faces: Uint8Array, size: number, f: number): string | null {
  const stride = size * size * 4;
  const slice = faces.subarray(f * stride, f * stride + stride);
  if (!slice.some((v, i) => i % 4 === 3 && v !== 0)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(slice), size, size), 0, 0);
  return canvas.toDataURL();
}
