// Turning about a point: the free-cursor drag while a selection gives the view somewhere
// to orbit. Positive yaw swings a camera on +Z toward +X; positive pitch raises it.

/** Just under straight up or down, so a look never flips over the pole. */
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * The offset from the pivot after one drag. `fallbackYaw` is the camera's yaw, used when the
 * offset sits on the vertical axis and a sideways drag would otherwise do nothing.
 */
export function orbitOffset(
  offset: readonly [number, number, number],
  yawDelta: number,
  pitchDelta: number,
  fallbackYaw: number,
): readonly [number, number, number] {
  const cos = Math.cos(-yawDelta);
  const sin = Math.sin(-yawDelta);
  const x0 = offset[0];
  const y0 = offset[1];
  const z0 = offset[2];
  const x = x0 * cos - z0 * sin;
  const z = x0 * sin + z0 * cos;
  const horizontal = Math.hypot(x, z);
  const pitch = Math.atan2(y0, horizontal);
  const nextPitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch + pitchDelta));
  const len = Math.hypot(x, y0, z) || 1;
  const facing = horizontal < 1e-8 ? fallbackYaw - yawDelta : Math.atan2(x, z);
  const reach = Math.cos(nextPitch) * len;
  return [Math.sin(facing) * reach, Math.sin(nextPitch) * len, Math.cos(facing) * reach];
}
