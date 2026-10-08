import { useMemo } from "react";
import { shapeIcon } from "./shape-icon.ts";

/** A shape drawn small, in three shades set by the page's colours. */
export function ShapeIcon({ shape, className }: { shape: string; className?: string }) {
  const polygons = useMemo(() => shapeIcon(shape), [shape]);
  return (
    <svg
      className={className ? `shape-icon ${className}` : "shape-icon"}
      viewBox="0 0 100 100"
      aria-hidden
    >
      {polygons.map((p, i) => (
        // The order is the paint order, and never changes for a shape.
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed paint order
        <polygon key={i} points={p.points} className={`shade-${p.shade}`} />
      ))}
    </svg>
  );
}
