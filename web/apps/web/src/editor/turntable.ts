// Drag a preview to turn it by hand. Block previews use it, and a prefab thumbnail can too:
// the angles are just yaw and pitch, so a CSS cube or a later renderer can both apply them.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";

/** Resting tilt, matching the old spinning cube. */
export const PREVIEW_PITCH = -24;
/** How far a drag may tip the preview, in degrees. */
export const PREVIEW_PITCH_LIMIT = 80;
/** One full turn of the idle spin. */
const SPIN_MS = 14000;

export interface TurnPose {
  readonly yaw: number;
  readonly pitch: number;
}

interface LivePose {
  yaw: number;
  pitch: number;
  held: boolean;
  taken: boolean;
}

/** Yaw and pitch after a drag of `dx`/`dy` pixels. Pitch stays short of flipping over. */
export function turnByDrag(
  pose: TurnPose,
  dx: number,
  dy: number,
  degreesPerPixel = 0.45,
): TurnPose {
  return {
    yaw: pose.yaw + dx * degreesPerPixel,
    pitch: Math.max(
      -PREVIEW_PITCH_LIMIT,
      Math.min(PREVIEW_PITCH_LIMIT, pose.pitch - dy * degreesPerPixel),
    ),
  };
}

/** A CSS transform for a pose: tilt, then turn. */
export function previewTransform(pose: TurnPose): string {
  return `rotateX(${pose.pitch}deg) rotateY(${pose.yaw}deg)`;
}

/**
 * Spins `ref`'s element until the pointer drags it, then holds the angle the drag left.
 * Handlers go on the hit target (a parent); `ref` goes on the element that turns.
 */
export function useTurntable() {
  const ref = useRef<HTMLDivElement>(null);
  const pose = useRef<LivePose>({
    yaw: 0,
    pitch: PREVIEW_PITCH,
    held: false,
    taken: false,
  });

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) pose.current.yaw = 35;
    const apply = () => {
      const el = ref.current;
      if (el) el.style.transform = previewTransform(pose.current);
    };
    apply();
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const current = pose.current;
      if (!reduced && !current.held && !current.taken) {
        current.yaw += (dt / SPIN_MS) * 360;
        apply();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    pose.current.held = true;
    pose.current.taken = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pose.current.held) return;
    const next = turnByDrag(pose.current, event.movementX, event.movementY);
    pose.current.yaw = next.yaw;
    pose.current.pitch = next.pitch;
    const el = ref.current;
    if (el) el.style.transform = previewTransform(pose.current);
  };
  const onPointerUp = () => {
    pose.current.held = false;
  };

  return { ref, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
