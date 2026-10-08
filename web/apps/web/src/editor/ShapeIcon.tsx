import type { CSSProperties } from "react";
import { useMemo } from "react";
import { shapeIcon } from "./shape-icon.ts";

/** A shape drawn small, in three shades set by the page's colours. */
export function ShapeIcon({
  shape,
  slot,
  color,
  className,
}: {
  shape: string;
  /** Which placement to draw. Omitted picks the angle that shows the shape. */
  slot?: number;
  /** Tints the three shades from this colour, instead of the page's greys. */
  color?: string;
  className?: string;
}) {
  const polygons = useMemo(() => shapeIcon(shape, slot), [shape, slot]);
  const style = color
    ? ({
        "--shape-top": color,
        "--shape-right": `color-mix(in srgb, ${color} 72%, #000)`,
        "--shape-left": `color-mix(in srgb, ${color} 48%, #000)`,
      } as CSSProperties)
    : undefined;
  return (
    <svg
      className={className ? `shape-icon ${className}` : "shape-icon"}
      style={style}
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
