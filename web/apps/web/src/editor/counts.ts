// How the selection panel writes a count: grouped thousands, and stacks of 64 (what you
// fetch from a chest). The same breakdown the Godot app's material list uses.

/** One inventory stack. A block that stacks differently would need its own size. */
export const STACK = 64;

/** "1,234". A region can hold millions of cells. */
export function grouped(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i] ?? "";
  }
  return sign + out;
}

/**
 * A quantity as stacks: "7×64 + 52" (or "8×64" when it fills them), "" below one full stack.
 * The panel shows it under the count.
 */
export function stacks(count: number): string {
  if (count < STACK) return "";
  const rest = count % STACK;
  const full = (count - rest) / STACK;
  return rest > 0 ? `${full}×${STACK} + ${rest}` : `${full}×${STACK}`;
}

/** "500" or "500 = 7×64 + 52", for the copied list. */
export function countText(count: number): string {
  const breakdown = stacks(count);
  const total = grouped(count);
  return breakdown === "" ? total : `${total} = ${breakdown}`;
}

/**
 * Moves one face of a box by `delta` cells (axis 0/1/2, `maxSide` the + face). The face stops
 * at the opposite one, so the box never turns inside out.
 */
export function nudgedBox(
  bounds: readonly [number, number, number, number, number, number],
  axis: 0 | 1 | 2,
  maxSide: boolean,
  delta: number,
): [number, number, number, number, number, number] {
  const next: [number, number, number, number, number, number] = [
    bounds[0],
    bounds[1],
    bounds[2],
    bounds[3],
    bounds[4],
    bounds[5],
  ];
  // axis is 0..2, so these land on the six faces. Addition widens the type, hence the cast.
  const index = (maxSide ? axis + 3 : axis) as 0 | 1 | 2 | 3 | 4 | 5;
  const opposite = (maxSide ? axis : axis + 3) as 0 | 1 | 2 | 3 | 4 | 5;
  const moved = next[index] + delta;
  const limit = next[opposite];
  next[index] = maxSide ? Math.max(limit, moved) : Math.min(limit, moved);
  return next;
}
