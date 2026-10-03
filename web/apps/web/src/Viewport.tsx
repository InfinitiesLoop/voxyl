import type { World } from "@voxyl/core";
import { useEffect, useRef } from "react";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as THREE from "three/webgpu";

export type Backend = "WebGPU" | "WebGL2";

interface ViewportProps {
  world: World;
  palette: Readonly<Record<string, string>>;
  onReady?: (backend: Backend) => void;
}

/**
 * The 3D lens on a World. For the shell it draws one instanced cube per cell, grouped by
 * semantic; Phase 0 replaces this with chunk meshes built in workers.
 */
export function Viewport({ world, palette, onReady }: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let disposed = false;
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#15171b");
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    camera.position.set(22, 18, 26);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 7, 0);
    // No damping: the camera stops the moment input stops.

    scene.add(new THREE.HemisphereLight("#dfe7ff", "#2a2d33", 1.4));
    const sun = new THREE.DirectionalLight("#ffffff", 2.2);
    sun.position.set(30, 50, 20);
    scene.add(sun);
    scene.add(new THREE.GridHelper(64, 64, "#3a3f47", "#262a30"));

    const meshes = buildCellMeshes(world, palette);
    for (const mesh of meshes) {
      scene.add(mesh);
    }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(window.devicePixelRatio);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);

    renderer.init().then(() => {
      if (disposed) {
        return;
      }
      host.appendChild(renderer.domElement);
      observer.observe(host);
      resize();
      const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
      onReady?.(backend ? "WebGPU" : "WebGL2");
      renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
      });
    });

    return () => {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [world, palette, onReady]);

  return <div ref={hostRef} className="viewport" />;
}

function buildCellMeshes(
  world: World,
  palette: Readonly<Record<string, string>>,
): THREE.InstancedMesh[] {
  const bySemantic = new Map<string, number[]>();
  world.forEachCell((x, y, z, id) => {
    const semantic = world.states.get(id)?.semantic ?? "";
    let positions = bySemantic.get(semantic);
    if (!positions) {
      positions = [];
      bySemantic.set(semantic, positions);
    }
    positions.push(x, y, z);
  });

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();
  const meshes: THREE.InstancedMesh[] = [];
  for (const [semantic, positions] of bySemantic) {
    // An unmapped semantic is undecided, not an error: it renders neutral.
    const material = new THREE.MeshStandardNodeMaterial({
      color: palette[semantic] ?? "#8a8f98",
      roughness: 0.85,
    });
    const mesh = new THREE.InstancedMesh(geometry.clone(), material, positions.length / 3);
    for (let i = 0; i < mesh.count; i++) {
      // Cell [x, y, z] spans x..x+1, so its centre is offset by half a cell.
      matrix.makeTranslation(
        (positions[i * 3] ?? 0) + 0.5,
        (positions[i * 3 + 1] ?? 0) + 0.5,
        (positions[i * 3 + 2] ?? 0) + 0.5,
      );
      mesh.setMatrixAt(i, matrix);
    }
    meshes.push(mesh);
  }
  geometry.dispose();
  return meshes;
}
