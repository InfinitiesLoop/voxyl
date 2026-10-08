import * as THREE from "three/webgpu";
import { codesOf, isKey } from "../editor/keymap.ts";
import { orbitOffset } from "../editor/orbit.ts";

// Bindings live in editor/keymap.ts (the Keys panel lists the same table), with a key for
// either hand for every action: move WASD / arrows, up Space / right Ctrl / right Alt, down
// Shift / "/", sprint a left Ctrl tap or "\" (up to 4x, resets when you stop), base speed
// "=" / "-" or numpad + / -. Movement is immediate: no damping or easing, the camera stops
// the moment the keys are released. The wheel belongs to the editor (the hotbar while flying,
// moving forward and back otherwise).
const FORWARD = codesOf("forward");
const BACK = codesOf("back");
const LEFT = codesOf("left");
const RIGHT = codesOf("right");
const UP = codesOf("up");
const DOWN = codesOf("down");
const FASTER = codesOf("faster");
const SLOWER = codesOf("slower");
const HANDLED = new Set([
  ...FORWARD,
  ...BACK,
  ...LEFT,
  ...RIGHT,
  ...UP,
  ...DOWN,
  ...codesOf("sprint"),
  ...FASTER,
  ...SLOWER,
]);

const MODIFIER = /^(?:Control|Alt|Shift|Meta)/;

/** Up and down move this many times faster than flying level. */
const VERTICAL_SPEED = 1.2;
const LOOK_RADIANS_PER_PIXEL = 0.0022;
/** Turning by dragging the view with a free cursor (Godot's 0.4 degrees a pixel). */
const DRAG_RADIANS_PER_PIXEL = 0.007;
const SPEED_STEP = 1.25;
const MIN_SPEED = 2;
const MAX_SPEED = 400;
const MAX_PITCH = Math.PI / 2 - 0.01;

export interface FlyPose {
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly speed: number;
}

/** Puts a stored pose on a camera that is not the one being flown. */
export function applyPose(camera: THREE.PerspectiveCamera, pose: FlyPose): void {
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
  camera.updateMatrixWorld();
}

/** First-person fly controls. Active while the pointer is locked to the canvas. */
export class FlyCamera {
  camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** Base speed in cells per second. */
  speed = 15;
  #sprint = 0;
  /** A sprint key that sprints on a tap (left Ctrl) is down, with nothing else pressed since. */
  #tapping: string | null = null;
  readonly #keys = new Set<string>();
  readonly #element: HTMLElement;
  readonly #abort = new AbortController();

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement) {
    this.camera = camera;
    this.#element = element;
    const signal = this.#abort.signal;
    document.addEventListener("keydown", (e) => this.#onKey(e, true), { signal });
    document.addEventListener("keyup", (e) => this.#onKey(e, false), { signal });
    document.addEventListener("mousemove", (e) => this.#onMouseMove(e), { signal });
    document.addEventListener("pointerlockchange", () => this.#keys.clear(), { signal });
    window.addEventListener("blur", () => this.#keys.clear(), { signal });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.#element;
  }

  lock(): void {
    // Rejects if the browser refuses (for example, too soon after the user pressed Esc).
    this.#element.requestPointerLock().catch(() => {});
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Drives a different camera, keeping the pose restore or update last set. */
  bind(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    this.#apply();
  }

  capture(): FlyPose {
    return {
      position: [this.position.x, this.position.y, this.position.z],
      yaw: this.yaw,
      pitch: this.pitch,
      speed: this.speed,
    };
  }

  restore(pose: FlyPose): void {
    this.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    this.speed = pose.speed;
    this.#apply();
  }

  /** Puts the camera at `position`, facing `target`. */
  place(position: THREE.Vector3Like, target: THREE.Vector3Like): void {
    this.position.set(position.x, position.y, position.z);
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dz = target.z - position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.#apply();
  }

  /**
   * Orbits `pivot` by a drag of the view, in pixels: the camera moves about the point and
   * keeps looking at it. A drag right swings toward the camera's right; a drag down raises it.
   */
  orbit(pivot: THREE.Vector3, dx: number, dy: number): void {
    const ox = this.position.x - pivot.x;
    const oy = this.position.y - pivot.y;
    const oz = this.position.z - pivot.z;
    const offset =
      ox * ox + oy * oy + oz * oz < 1e-4 ? ([0, 0, 4] as const) : ([ox, oy, oz] as const);
    const next = orbitOffset(
      offset,
      dx * DRAG_RADIANS_PER_PIXEL,
      dy * DRAG_RADIANS_PER_PIXEL,
      this.yaw,
    );
    this.position.set(pivot.x + next[0], pivot.y + next[1], pivot.z + next[2]);
    const lookX = -next[0];
    const lookY = -next[1];
    const lookZ = -next[2];
    this.yaw = Math.atan2(-lookX, -lookZ);
    this.pitch = Math.atan2(lookY, Math.hypot(lookX, lookZ));
    this.#apply();
  }

  /** Turns the camera by a drag of the view with a free cursor, in pixels. */
  drag(dx: number, dy: number): void {
    this.#look(dx * DRAG_RADIANS_PER_PIXEL, dy * DRAG_RADIANS_PER_PIXEL);
    this.#apply();
  }

  /** Moves the camera along where it looks, by `cells` (negative goes back). */
  dolly(cells: number): void {
    this.position.addScaledVector(this.forward(), cells);
    this.#apply();
  }

  /** Multiplies the base speed (within limits). */
  scaleSpeed(factor: number): void {
    this.speed = THREE.MathUtils.clamp(this.speed * factor, MIN_SPEED, MAX_SPEED);
  }

  /** The direction the camera looks, as a unit vector. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }

  update(dt: number): void {
    const held = (codes: readonly string[]) => codes.some((c) => this.#keys.has(c));
    const move = new THREE.Vector3();
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (held(FORWARD)) move.add(forward);
    if (held(BACK)) move.sub(forward);
    if (held(RIGHT)) move.add(right);
    if (held(LEFT)) move.sub(right);
    const rise = (held(UP) ? 1 : 0) - (held(DOWN) ? 1 : 0);
    if (move.lengthSq() === 0 && rise === 0) {
      this.#sprint = 0;
    } else {
      // Climbing is its own axis, so it keeps full speed while moving sideways too.
      const step = this.speed * 2 ** this.#sprint * dt;
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(step);
      move.y = rise * step * VERTICAL_SPEED;
      this.position.add(move);
    }
    this.#apply();
  }

  dispose(): void {
    this.#abort.abort();
    this.unlock();
  }

  #apply(): void {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld();
  }

  #onKey(event: KeyboardEvent, down: boolean): void {
    // Any other key between a tap key's press and release makes it a modifier, not a tap.
    if (down && event.code !== this.#tapping) this.#tapping = null;
    if (!this.locked || !HANDLED.has(event.code)) return;
    event.preventDefault();
    if (isKey("sprint", event.code)) {
      if (event.repeat) return;
      // A modifier (left Ctrl) is also Ctrl: it sprints when let go untouched. Others on the press.
      const onTap = MODIFIER.test(event.code);
      if (onTap) {
        if (down) this.#tapping = event.code;
        else if (this.#tapping === event.code) this.#sprintStep();
        if (!down) this.#tapping = null;
      } else if (down) this.#sprintStep();
      return;
    }
    if (FASTER.includes(event.code) || SLOWER.includes(event.code)) {
      if (down) this.scaleSpeed(FASTER.includes(event.code) ? SPEED_STEP : 1 / SPEED_STEP);
      return;
    }
    if (down) this.#keys.add(event.code);
    else this.#keys.delete(event.code);
  }

  /** A mouse button went down while a tap key was held: it is a modifier now, not a tap. */
  cancelTap(): void {
    this.#tapping = null;
  }

  #sprintStep(): void {
    this.#sprint = Math.min(this.#sprint + 1, 2);
  }

  #onMouseMove(event: MouseEvent): void {
    if (!this.locked) return;
    this.#look(event.movementX * LOOK_RADIANS_PER_PIXEL, event.movementY * LOOK_RADIANS_PER_PIXEL);
  }

  #look(yaw: number, pitch: number): void {
    this.yaw -= yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - pitch, -MAX_PITCH, MAX_PITCH);
  }
}
