import { useEffect, useRef } from "react";
import { COMPASS_POINTS, type CompassPoint } from "./compass.ts";

const SIZE = 46;
const C = SIZE / 2;
/** Where the letters sit, from the centre. */
const LETTERS = 15;

/**
 * A small compass in a pane's corner: a faint disc, a needle toward the real north with an
 * N, and dim E, S and W. `heading` is read every frame (the clockwise angle from screen-up
 * to north, in radians), so the 3D views turn it without going through React.
 */
export function Compass({ heading }: { heading: () => number | null }) {
  const rootRef = useRef<SVGSVGElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const letterRefs = useRef(new Map<CompassPoint, SVGTextElement>());
  const read = useRef(heading);
  read.current = heading;

  useEffect(() => {
    let frame = 0;
    let shown = Number.NaN;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const angle = read.current();
      const root = rootRef.current;
      if (!root) return;
      root.style.visibility = angle === null ? "hidden" : "visible";
      if (angle === null || Math.abs(angle - shown) < 1e-4) return;
      shown = angle;
      needleRef.current?.setAttribute("transform", `rotate(${(angle * 180) / Math.PI} ${C} ${C})`);
      COMPASS_POINTS.forEach((point, i) => {
        const a = angle + (i * Math.PI) / 2;
        const el = letterRefs.current.get(point);
        el?.setAttribute("x", (C + Math.sin(a) * LETTERS).toFixed(2));
        el?.setAttribute("y", (C - Math.cos(a) * LETTERS).toFixed(2));
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg
      ref={rootRef}
      className="compass"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label="Compass"
    >
      <circle cx={C} cy={C} r={C - 1} className="compass-disc" />
      <g ref={needleRef}>
        <path d={`M ${C} ${C - 8} L ${C + 3} ${C} L ${C - 3} ${C} Z`} className="compass-north" />
        <path d={`M ${C} ${C + 8} L ${C + 3} ${C} L ${C - 3} ${C} Z`} className="compass-south" />
      </g>
      {COMPASS_POINTS.map((point) => (
        <text
          key={point}
          ref={(el) => {
            if (el) letterRefs.current.set(point, el);
            else letterRefs.current.delete(point);
          }}
          className={point === "N" ? "compass-letter north" : "compass-letter"}
          x={C}
          y={C}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {point}
        </text>
      ))}
    </svg>
  );
}
