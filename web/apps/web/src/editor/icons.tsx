import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine } from "../scene/Engine.ts";

/** Grid icons. The inventory's preview asks for a larger one. */
export const ICON_PX = 64;
export const PREVIEW_PX = 128;
const BATCH = 4;

/**
 * Bakes block icons on the world worker, a few at a time, and keeps the pictures. Listings
 * ask for what they can see; the rest wait, so opening a library doesn't stall editing.
 */
class BlockIconBaker {
  readonly #engine: Engine;
  readonly #url = new Map<string, string>();
  readonly #miss = new Set<string>();
  readonly #queued = new Set<string>();
  readonly #queue: { ref: string; size: number }[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();
  #timer = 0;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  url(ref: string, size: number): string | undefined {
    return this.#url.get(keyOf(ref, size));
  }

  /** Calls `listener` once the icon is ready. Returns an unsubscribe. */
  want(ref: string, size: number, listener: () => void): () => void {
    const key = keyOf(ref, size);
    const set = this.#listeners.get(key) ?? new Set();
    set.add(listener);
    this.#listeners.set(key, set);
    if (!this.#url.has(key) && !this.#miss.has(key) && !this.#queued.has(key)) {
      this.#queued.add(key);
      this.#queue.push({ ref, size });
      this.#schedule();
    }
    return () => set.delete(listener);
  }

  /** Drops every picture, so a replaced library bakes again. */
  clear(): void {
    this.#url.clear();
    this.#miss.clear();
    this.#queued.clear();
    this.#queue.length = 0;
    for (const set of this.#listeners.values()) for (const listener of set) listener();
  }

  #schedule(): void {
    if (this.#timer !== 0) return;
    this.#timer = window.setTimeout(() => void this.#flush(), 16);
  }

  async #flush(): Promise<void> {
    this.#timer = 0;
    const size = this.#queue[0]?.size;
    if (size === undefined) return;
    const batch: { ref: string; size: number }[] = [];
    const rest: { ref: string; size: number }[] = [];
    for (const item of this.#queue) {
      if (item.size === size && batch.length < BATCH) batch.push(item);
      else rest.push(item);
    }
    this.#queue.length = 0;
    this.#queue.push(...rest);
    try {
      const baked = await this.#engine.world.request({
        type: "bakeIcons",
        refs: batch.map((item) => item.ref),
        size,
      });
      const stride = size * size * 4;
      batch.forEach((item, i) => {
        const key = keyOf(item.ref, size);
        this.#queued.delete(key);
        const slice = baked.icons.subarray(i * stride, (i + 1) * stride);
        if (hasPixel(slice)) this.#url.set(key, pngUrl(slice, size));
        else this.#miss.add(key);
        for (const listener of this.#listeners.get(key) ?? []) listener();
      });
    } catch (caught) {
      console.error(caught);
      for (const item of batch) this.#queued.delete(keyOf(item.ref, item.size));
    }
    if (this.#queue.length > 0) this.#schedule();
  }
}

const bakers = new WeakMap<Engine, BlockIconBaker>();

function blockIcons(engine: Engine): BlockIconBaker {
  let baker = bakers.get(engine);
  if (!baker) {
    baker = new BlockIconBaker(engine);
    bakers.set(engine, baker);
  }
  return baker;
}

/** Forgets baked icons after a library is imported or removed. */
export function clearBlockIcons(engine: Engine): void {
  bakers.get(engine)?.clear();
}

/**
 * A block's baked picture, or its colour until the bake arrives. A semantic with no block is
 * baked as a cube in its colour.
 * `size` is the bake's pixels; CSS sets how big it is drawn. A picture is baked once it
 * scrolls into view, so a long library doesn't bake every block at once.
 */
export function BakedIcon({
  engine,
  block,
  color,
  size = ICON_PX,
  className = "baked-icon",
}: {
  engine: Engine;
  block?: string | undefined;
  color: string;
  size?: number;
  className?: string;
}) {
  const icons = blockIcons(engine);
  // An undecided semantic is baked as a cube in its colour, so it reads like a block too.
  const ref = block || (/^#[0-9a-f]{6}$/i.test(color) ? `color:${color}` : undefined);
  const nodeRef = useRef<HTMLElement | null>(null);
  const setNode = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
  }, []);
  const [seen, setSeen] = useState(false);
  const [url, setUrl] = useState<string | undefined>(() =>
    ref ? icons.url(ref, size) : undefined,
  );
  useEffect(() => {
    if (!ref || seen) return;
    const node = nodeRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, seen]);
  useEffect(() => {
    if (!ref || !seen) {
      if (!ref) setUrl(undefined);
      return;
    }
    setUrl(icons.url(ref, size));
    return icons.want(ref, size, () => setUrl(icons.url(ref, size)));
  }, [icons, ref, size, seen]);
  if (!url) {
    return <span ref={setNode} className={`swatch ${className}`} style={{ background: color }} />;
  }
  return <img ref={setNode} className={className} src={url} alt="" draggable={false} />;
}

function keyOf(ref: string, size: number): string {
  return `${size}:${ref}`;
}

function hasPixel(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return true;
  return false;
}

function pngUrl(rgba: Uint8Array, size: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const copy = new Uint8ClampedArray(rgba.byteLength);
  copy.set(rgba);
  ctx.putImageData(new ImageData(copy, size, size), 0, 0);
  return canvas.toDataURL();
}
