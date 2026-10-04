import * as THREE from "three/webgpu";

// Bindings follow the Godot app, with right-hand options for every action:
// move WASD / arrows, up Space / right Ctrl / right Alt, down Shift / "/", sprint "\" (tap,
// up to 4x, resets when you stop). The wheel scales base speed. Movement is immediate: no
// damping or easing, the camera stops the moment the keys are released.
const FORWARD = ["KeyW", "ArrowUp"];
const BACK = ["KeyS", "ArrowDown"];
const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const UP = ["Space", "ControlRight", "AltRight"];
const DOWN = ["ShiftLeft", "ShiftRight", "Slash"];
const SPRINT = "Backslash";
const HANDLED = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT, ...UP, ...DOWN, SPRINT]);

/** Up and down move this many times faster than flying level. */
const VERTICAL_SPEED = 1.2;
const LOOK_RADIANS_PER_PIXEL = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

/** First-person fly controls. Active while the pointer is locked to the canvas. */
export class FlyCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** Base speed in cells per second. */
  speed = 30;
  #sprint = 0;
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
    element.addEventListener("wheel", (e) => this.#onWheel(e), { signal, passive: false });
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
    if (!this.locked || !HANDLED.has(event.code)) return;
    event.preventDefault();
    if (event.code === SPRINT) {
      if (down && !event.repeat) this.#sprint = Math.min(this.#sprint + 1, 2);
      return;
    }
    if (down) this.#keys.add(event.code);
    else this.#keys.delete(event.code);
  }

  #onMouseMove(event: MouseEvent): void {
    if (!this.locked) return;
    this.yaw -= event.movementX * LOOK_RADIANS_PER_PIXEL;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - event.movementY * LOOK_RADIANS_PER_PIXEL,
      -MAX_PITCH,
      MAX_PITCH,
    );
  }

  #onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.speed = THREE.MathUtils.clamp(this.speed * (event.deltaY < 0 ? 1.25 : 0.8), 2, 400);
  }
}
