import { useEffect, useRef, useState } from "react";
import type { PieceSurface } from "../world/clipboard.ts";
import { partMesh } from "./part-mesh.ts";
import { PREVIEW_PITCH_LIMIT } from "./turntable.ts";

/** One full turn of the idle spin, in milliseconds. */
const SPIN_MS = 24000;
/** Past this many cells the picture holds still until it is dragged. */
const SPIN_LIMIT = 60000;
/** Each cell is drawn a hair smaller, so neighbours read as separate blocks. */
const SHRINK = 0.96;
const FOV = 35;

/**
 * A piece drawn turning: its visible cells as lit cubes in their semantics' colours, its shaped
 * parts (microblocks, roofs) as their own geometry, and the box round them. Drag to turn it,
 * wheel to zoom. Used wherever a region is taken apart (the prefab and schematic dialogs, a
 * prefab's details), so they all show the same picture. It is only a picture of what is kept;
 * it holds no data.
 */
export function PiecePreview({
  surface,
  className,
}: {
  surface: PieceSurface | null;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<PreviewHandle | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const target = host.current;
    if (!target) return;
    void startPreview(target).then(
      (handle) => {
        if (!live) {
          handle.dispose();
          return;
        }
        view.current = handle;
        if (latest.current) handle.show(latest.current);
      },
      () => live && setProblem("This browser can't draw the preview."),
    );
    return () => {
      live = false;
      view.current?.dispose();
      view.current = null;
    };
  }, []);

  // The surface to show, kept so a preview that finishes starting after it arrived still gets it.
  const latest = useRef<PieceSurface | null>(surface);
  latest.current = surface;
  useEffect(() => {
    if (surface) view.current?.show(surface);
  }, [surface]);

  return (
    <div
      ref={host}
      className={className ? `piece-preview ${className}` : "piece-preview"}
      title="Drag to turn, wheel to zoom"
    >
      {problem && <p className="piece-preview-note">{problem}</p>}
      {!problem && surface && !surface.drawn && (
        <p className="piece-preview-note">Too big to draw. It will still be kept in full.</p>
      )}
      {!problem && surface && surface.drawn && surface.cells === 0 && (
        <p className="piece-preview-note">Nothing is left.</p>
      )}
    </div>
  );
}

interface PreviewHandle {
  show(surface: PieceSurface): void;
  dispose(): void;
}

async function startPreview(host: HTMLElement): Promise<PreviewHandle> {
  // Loaded when a dialog first opens, so the editor itself doesn't carry a second renderer.
  const THREE = await import("three");
  // A canvas of its own: a renderer whose context was given up can't be handed to another.
  const canvas = document.createElement("canvas");
  host.prepend(canvas);
  let renderer: InstanceType<typeof THREE.WebGLRenderer>;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 5000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.6, 1, 0.8);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xaabbff, 0.4);
  fill.position.set(-0.8, -0.3, -0.6);
  scene.add(fill);

  const geometry = new THREE.BoxGeometry(SHRINK, SHRINK, SHRINK);
  const material = new THREE.MeshLambertMaterial();
  const partMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x8be9ff,
    transparent: true,
    opacity: 0.55,
  });
  const pivot = new THREE.Group();
  scene.add(pivot);

  let cubes: InstanceType<typeof THREE.InstancedMesh> | null = null;
  let shapes: InstanceType<typeof THREE.Mesh> | null = null;
  let frame: InstanceType<typeof THREE.LineSegments> | null = null;
  let radius = 5;
  let spins = true;
  const pose = { yaw: 35, pitch: 24 };
  let zoom = 1;
  let held = false;
  let taken = false;
  let dirty = true;
  let raf = 0;
  let last = performance.now();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const place = () => {
    const distance = (radius / Math.sin((FOV * Math.PI) / 360)) * 1.02 * zoom;
    const pitch = (pose.pitch * Math.PI) / 180;
    const yaw = (pose.yaw * Math.PI) / 180;
    camera.position.set(
      Math.sin(yaw) * Math.cos(pitch) * distance,
      Math.sin(pitch) * distance,
      Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    camera.near = Math.max(0.1, distance - radius * 2);
    camera.far = distance + radius * 3;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    dirty = true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    if (spins && !reduced && !held && !taken) {
      pose.yaw += (dt / SPIN_MS) * 360;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      place();
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const down = (event: PointerEvent) => {
    held = true;
    taken = true;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!held) return;
    pose.yaw -= event.movementX * 0.45;
    pose.pitch = Math.max(
      -PREVIEW_PITCH_LIMIT,
      Math.min(PREVIEW_PITCH_LIMIT, pose.pitch + event.movementY * 0.45),
    );
    dirty = true;
  };
  const up = () => {
    held = false;
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    zoom = Math.min(4, Math.max(0.15, zoom * Math.exp(event.deltaY * 0.001)));
    dirty = true;
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });

  const clear = () => {
    if (cubes) {
      pivot.remove(cubes);
      cubes.dispose();
      cubes = null;
    }
    if (shapes) {
      pivot.remove(shapes);
      shapes.geometry.dispose();
      shapes = null;
    }
    if (frame) {
      pivot.remove(frame);
      frame.geometry.dispose();
      frame = null;
    }
  };

  return {
    show(surface) {
      clear();
      const [w, h, d] = surface.size;
      if (w === 0) {
        dirty = true;
        return;
      }
      const count = surface.positions.length / 3;
      if (count > 0) {
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();
        for (let i = 0; i < count; i++) {
          matrix.makeTranslation(
            (surface.positions[i * 3] ?? 0) + 0.5 - w / 2,
            (surface.positions[i * 3 + 1] ?? 0) + 0.5 - h / 2,
            (surface.positions[i * 3 + 2] ?? 0) + 0.5 - d / 2,
          );
          mesh.setMatrixAt(i, matrix);
          color.setRGB(
            (surface.colors[i * 3] ?? 128) / 255,
            (surface.colors[i * 3 + 1] ?? 128) / 255,
            (surface.colors[i * 3 + 2] ?? 128) / 255,
            THREE.SRGBColorSpace,
          );
          mesh.setColorAt(i, color);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        pivot.add(mesh);
        cubes = mesh;
      }
      if (surface.parts.slots.length > 0) {
        const built = partMesh(surface.parts, [w / 2, h / 2, d / 2]);
        const parts = new THREE.BufferGeometry();
        parts.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
        parts.setAttribute("normal", new THREE.BufferAttribute(built.normals, 3));
        parts.setAttribute("color", new THREE.BufferAttribute(built.colors, 3));
        shapes = new THREE.Mesh(parts, partMaterial);
        pivot.add(shapes);
      }
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
      frame = new THREE.LineSegments(edges, lineMaterial);
      pivot.add(frame);
      radius = Math.max(1, Math.sqrt(w * w + h * h + d * d) / 2);
      spins = count + surface.parts.slots.length <= SPIN_LIMIT;
      dirty = true;
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      clear();
      geometry.dispose();
      material.dispose();
      partMaterial.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
