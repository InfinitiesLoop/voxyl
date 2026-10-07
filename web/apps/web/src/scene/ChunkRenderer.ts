import { chunkKeyToCoords } from "@voxyl/core";
import { GPU_BRICK_BITS } from "@voxyl/light";
import { EDGE_WORDS, QUAD_BYTES, QUAD_WORDS, TRI_BYTES, TRI_WORDS } from "@voxyl/mesher";
import type { LightingMode } from "@voxyl/session";
import { attribute, texture, varying, vec2 } from "three/tsl";
import * as THREE from "three/webgpu";
import type { RenderMode, Shading } from "../editor/view-options.ts";
import type { LooksUpdate } from "../world/protocol.ts";
import type { WorldOutput } from "../world/WorldClient.ts";
import { BlockTextures } from "./block-textures.ts";
import { LightVolume } from "./light-volume.ts";
import {
  type ColorSources,
  createFlatMaterial,
  createLightUniforms,
  createViewUniforms,
  createVolumeLitMaterial,
  EMISSIVE_ALPHA,
  type LightUniforms,
  PALETTE_SIZE,
  type SurfaceKind,
  VIEW_COLOR,
  VIEW_SHADE,
  type ViewUniforms,
} from "./quad-material.ts";

type MaterialSet = Record<SurfaceKind, THREE.MeshBasicNodeMaterial>;

/** The render modes drawn with feature edges, which the world worker must then send. */
export function usesEdges(mode: RenderMode): boolean {
  return mode === "outline" || mode === "xray" || mode === "wire";
}

const COLOR_OF: Record<RenderMode, number> = {
  textured: VIEW_COLOR.textured,
  intent: VIEW_COLOR.intent,
  clay: VIEW_COLOR.clay,
  outline: VIEW_COLOR.fill,
  xray: VIEW_COLOR.fill,
  wire: VIEW_COLOR.fill,
};

/** Main-thread time per frame spent applying meshes and light from the world worker. */
const APPLY_BUDGET_MS = 4;

type Update = Extract<WorldOutput, { type: "mesh" } | { type: "light" } | { type: "idle" }>;

export interface ChunkRendererStats {
  readonly meshes: number;
  readonly quads: number;
  /** Triangles of shaped parts. */
  readonly tris: number;
  /** GPU bytes held by quads and triangles. */
  readonly quadBytes: number;
  /** Updates from the world worker waiting to be applied. */
  readonly pending: number;
  readonly lighting: LightingMode;
  /** Light volume memory on the GPU. */
  readonly lightGpuMb: number;
  /** Time to apply one light update (up to 4096 bricks) on this thread, over recent ones. */
  readonly lightWriteMs: number;
}

/**
 * Draws one world's chunks from what the world worker sends: meshes, light volume writes
 * and idle markers, applied in arrival order within a per-frame budget. It owns nothing
 * about the world itself, only GPU state: one mesh per chunk, the materials, the palette
 * texture and the light volume.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly #renderer: THREE.WebGPURenderer;
  readonly #size: number;
  readonly #chunkBits: number;
  readonly #paletteData: Uint8Array;
  readonly #paletteTexture: THREE.DataTexture;
  readonly #intentData: Uint8Array;
  readonly #intentTexture: THREE.DataTexture;
  readonly #uniforms: LightUniforms = createLightUniforms();
  readonly #view: ViewUniforms = createViewUniforms();
  readonly #blocks = new BlockTextures();
  readonly #sources: ColorSources;
  readonly #flatMaterials: MaterialSet;
  readonly #xrayMaterials: MaterialSet;
  /** The set the meshes have now; a pane that wants another swaps them. */
  #current: MaterialSet | null = null;
  /** The feature-edge lines, one per chunk, drawn by the line-drawing modes. */
  readonly #edgeGroup = new THREE.Group();
  readonly #edges = new Map<number, THREE.LineSegments>();
  /** Edges dark and hidden by faces (Outline), or in intent colours through everything. */
  readonly #edgeDark: THREE.LineBasicNodeMaterial;
  readonly #edgeColor: THREE.LineBasicNodeMaterial;
  readonly #faceGroup = new THREE.Group();
  #intent: Uint8Array = new Uint8Array(0);
  /** StateLooks.colors from the world worker. */
  #looks: Uint8Array = new Uint8Array(0);
  #paletteDirty = true;
  #mode: LightingMode = "off";
  #volume: LightVolume | null = null;
  #volumeMaterials: Record<SurfaceKind, THREE.MeshBasicNodeMaterial> | null = null;
  /** Whether meshes draw with the light volume yet (see revealLight). */
  #lightShown = false;
  readonly #meshes = new Map<number, ChunkMeshes>();
  readonly #updates: Update[] = [];
  #appliedSeq = -1;
  #quads = 0;
  #tris = 0;
  readonly #writeTimes: number[] = [];

  constructor(renderer: THREE.WebGPURenderer, chunkSize: number) {
    this.#renderer = renderer;
    this.#size = chunkSize;
    this.#chunkBits = Math.log2(chunkSize);
    this.#paletteData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#paletteTexture = new THREE.DataTexture(this.#paletteData, PALETTE_SIZE, PALETTE_SIZE);
    this.#paletteTexture.colorSpace = THREE.SRGBColorSpace;
    this.#paletteTexture.magFilter = THREE.NearestFilter;
    this.#paletteTexture.minFilter = THREE.NearestFilter;
    this.#paletteTexture.generateMipmaps = false;
    this.#intentData = new Uint8Array(PALETTE_SIZE * PALETTE_SIZE * 4);
    this.#intentTexture = new THREE.DataTexture(this.#intentData, PALETTE_SIZE, PALETTE_SIZE);
    this.#intentTexture.colorSpace = THREE.SRGBColorSpace;
    this.#intentTexture.magFilter = THREE.NearestFilter;
    this.#intentTexture.minFilter = THREE.NearestFilter;
    this.#intentTexture.generateMipmaps = false;
    this.#sources = {
      palette: this.#paletteTexture,
      intent: this.#intentTexture,
      blocks: this.#blocks,
      view: this.#view,
    };
    this.#flatMaterials = {
      quad: createFlatMaterial(this.#sources, "quad"),
      tri: createFlatMaterial(this.#sources, "tri"),
    };
    this.#xrayMaterials = {
      quad: createFlatMaterial(this.#sources, "quad", true),
      tri: createFlatMaterial(this.#sources, "tri", true),
    };
    this.#edgeDark = new THREE.LineBasicNodeMaterial({ color: 0x15171b, fog: false });
    this.#edgeColor = new THREE.LineBasicNodeMaterial({
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    // An edge's colour is its state's intent colour, looked up per vertex.
    const id = attribute("edgeId", "float");
    const uv = varying<"vec2">(
      vec2(id.mod(PALETTE_SIZE), id.div(PALETTE_SIZE).floor()).add(0.5).div(PALETTE_SIZE),
    );
    this.#edgeColor.colorNode = texture(this.#intentTexture, uv).rgb;
    this.#edgeGroup.visible = false;
    this.#edgeGroup.renderOrder = 2;
    this.group.add(this.#faceGroup, this.#edgeGroup);
    this.group.name = "chunks";
  }

  get lighting(): LightingMode {
    return this.#mode;
  }

  /** The sequence number of the last idle marker applied (see WorldClient.sentSeq). */
  get appliedSeq(): number {
    return this.#appliedSeq;
  }

  /** True when nothing from the world worker is waiting to be applied. */
  get caughtUp(): boolean {
    return this.#updates.length === 0;
  }

  /**
   * Switches how faces are lit. With lighting on, a light volume fills as the world worker
   * sends light; meshes keep drawing flat until revealLight(), so the world lights up at
   * once rather than a few chunks at a time.
   */
  setLighting(mode: LightingMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#volume?.dispose();
    this.#disposeVolumeMaterials();
    this.#volume = null;
    this.#lightShown = false;
    if (mode === "volume") {
      const brickBits = Math.min(GPU_BRICK_BITS, this.#chunkBits);
      this.#volume = new LightVolume(
        this.#renderer,
        1 << (3 * brickBits),
        (this.#size >> brickBits) ** 3,
      );
      const lit = (kind: SurfaceKind) =>
        createVolumeLitMaterial(
          this.#sources,
          this.#uniforms,
          this.#volume as LightVolume,
          this.#chunkBits,
          brickBits,
          kind,
        );
      this.#volumeMaterials = { quad: lit("quad"), tri: lit("tri") };
    }
    this.#applyMaterial();
  }

  /** Starts drawing with the light volume. Call once its light has arrived. */
  revealLight(): void {
    if (!this.#volumeMaterials || this.#lightShown) return;
    this.#lightShown = true;
    this.#applyMaterial();
  }

  /** Time of day, 0 (midnight) to 1 (noon). Costs nothing: it's one shader value. */
  setDaylight(daylight: number): void {
    this.#uniforms.daylight.value = daylight;
  }

  /** Minecraft's Brightness: 0 Moody, 0.5 default, 1 Bright. One shader value. */
  setBrightness(brightness: number): void {
    this.#uniforms.brightness.value = brightness;
  }

  /**
   * Every cell state's look, as the world worker resolves it from the project's palettes:
   * colours and textured faces. Only the palette and block tables change, never a mesh.
   */
  setLooks(looks: LooksUpdate): void {
    this.#looks = looks.colors;
    this.#intent = looks.intent;
    this.#paletteDirty = true;
    this.#blocks.update(looks);
  }

  /** Queues a mesh, light update or idle marker from the world worker; applied in update(). */
  receive(update: Update): void {
    this.#updates.push(update);
  }

  /**
   * Call once per frame before rendering. Meshes go first: a light upload must not hold
   * back the blocks an undo just changed, or two quick undos land in the same later frame.
   */
  update(): void {
    this.#syncPalette();
    const meshes: Update[] = [];
    const rest: Update[] = [];
    for (const update of this.#updates) {
      if (update.type === "mesh") meshes.push(update);
      else rest.push(update);
    }
    // Two meshes of one chunk in the same batch: only the latest is worth uploading.
    const latest = new Map<number, Update>();
    for (const mesh of meshes) if (mesh.type === "mesh") latest.set(mesh.key, mesh);
    const ordered = [...latest.values(), ...rest];
    const start = performance.now();
    let i = 0;
    for (; i < ordered.length && performance.now() - start < APPLY_BUDGET_MS; i++) {
      const update = ordered[i];
      if (!update) continue;
      if (update.type === "idle") this.#appliedSeq = update.seq;
      else if (update.type === "light") this.#applyLight(update.update);
      else {
        if (update.quadCount === 0 && update.triCount === 0) this.#removeMesh(update.key);
        else this.#setMesh(update.key, update.quads, update.tris);
        this.#setEdges(update.key, update.edges);
      }
    }
    this.#updates.splice(0, this.#updates.length, ...ordered.slice(i));
  }

  stats(): ChunkRendererStats {
    const times = this.#writeTimes;
    return {
      meshes: this.#meshes.size,
      quads: this.#quads,
      tris: this.#tris,
      quadBytes: this.#quads * QUAD_BYTES + this.#tris * TRI_BYTES,
      pending: this.#updates.length,
      lighting: this.#mode,
      lightGpuMb: (this.#volume?.memoryBytes ?? 0) / 2 ** 20,
      lightWriteMs: times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0,
    };
  }

  /**
   * How the next pane draws: its render mode and shading. Call before each pane renders;
   * it swaps the meshes' materials only when the set changes, and sets shader values.
   */
  setView(mode: RenderMode, shading: Shading): void {
    const lit = this.#lightShown ? this.#volumeMaterials : null;
    const set =
      mode === "xray" ? this.#xrayMaterials : shading === "app" && lit ? lit : this.#flatMaterials;
    this.#view.color.value = COLOR_OF[mode];
    this.#view.shade.value =
      shading === "studio"
        ? VIEW_SHADE.studio
        : shading === "flat"
          ? VIEW_SHADE.none
          : VIEW_SHADE.facing;
    this.#swapMaterials(set);
    this.#faceGroup.visible = mode !== "wire";
    this.#edgeGroup.visible = usesEdges(mode);
    const edge = mode === "outline" ? this.#edgeDark : this.#edgeColor;
    for (const line of this.#edges.values()) line.material = edge;
  }

  dispose(): void {
    for (const key of [...this.#meshes.keys()]) this.#removeMesh(key);
    for (const line of this.#edges.values()) line.geometry.dispose();
    this.#edges.clear();
    this.group.clear();
    this.#flatMaterials.quad.dispose();
    this.#flatMaterials.tri.dispose();
    this.#xrayMaterials.quad.dispose();
    this.#xrayMaterials.tri.dispose();
    this.#edgeDark.dispose();
    this.#edgeColor.dispose();
    this.#intentTexture.dispose();
    this.#disposeVolumeMaterials();
    this.#volume?.dispose();
    this.#paletteTexture.dispose();
    this.#blocks.dispose();
  }

  #material(kind: SurfaceKind): THREE.Material {
    if (this.#current) return this.#current[kind];
    const lit = this.#lightShown ? this.#volumeMaterials : null;
    return (lit ?? this.#flatMaterials)[kind];
  }

  /** Lighting changed: the next setView picks the set again; until then, the default. */
  #applyMaterial(): void {
    this.#current = null;
    this.#swapMaterials((this.#lightShown ? this.#volumeMaterials : null) ?? this.#flatMaterials);
  }

  #swapMaterials(set: MaterialSet): void {
    if (this.#current === set) return;
    this.#current = set;
    for (const meshes of this.#meshes.values()) {
      if (meshes.quads) meshes.quads.material = set.quad;
      if (meshes.tris) meshes.tris.material = set.tri;
    }
  }

  /** A chunk's feature edges as lines (empty removes them). */
  #setEdges(key: number, edges: Uint16Array): void {
    const old = this.#edges.get(key);
    if (old) {
      old.geometry.dispose();
      this.#edgeGroup.remove(old);
      this.#edges.delete(key);
    }
    const count = edges.length / EDGE_WORDS;
    if (count === 0) return;
    const positions = new Float32Array(count * 6);
    const ids = new Float32Array(count * 2);
    for (let e = 0; e < count; e++) {
      const w = e * EDGE_WORDS;
      const x = edges[w] ?? 0;
      const y = edges[w + 1] ?? 0;
      const z = edges[w + 2] ?? 0;
      const axis = edges[w + 3] ?? 0;
      const length = edges[w + 4] ?? 0;
      positions.set([x, y, z, x, y, z], e * 6);
      positions[e * 6 + 3 + axis] = (positions[e * 6 + 3 + axis] ?? 0) + length;
      ids[e * 2] = edges[w + 5] ?? 0;
      ids[e * 2 + 1] = edges[w + 5] ?? 0;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("edgeId", new THREE.BufferAttribute(ids, 1));
    setChunkBounds(geometry, this.#size);
    const line = new THREE.LineSegments(geometry, this.#edgeColor);
    const [cx, cy, cz] = chunkKeyToCoords(key);
    line.position.set(cx * this.#size, cy * this.#size, cz * this.#size);
    line.matrixAutoUpdate = false;
    line.updateMatrix();
    line.renderOrder = 2;
    this.#edgeGroup.add(line);
    this.#edges.set(key, line);
  }

  #disposeVolumeMaterials(): void {
    this.#volumeMaterials?.quad.dispose();
    this.#volumeMaterials?.tri.dispose();
    this.#volumeMaterials = null;
  }

  #applyLight(update: Parameters<LightVolume["apply"]>[0]): void {
    if (!this.#volume) return;
    const start = performance.now();
    this.#volume.apply(update);
    this.#writeTimes.push(performance.now() - start);
    if (this.#writeTimes.length > 64) this.#writeTimes.shift();
  }

  #syncPalette(): void {
    if (!this.#paletteDirty) return;
    const data = this.#paletteData;
    const looks = this.#looks;
    const count = Math.min(looks.length, data.length);
    for (let i = 4; i < count; i += 4) {
      data[i] = looks[i] ?? 0;
      data[i + 1] = looks[i + 1] ?? 0;
      data[i + 2] = looks[i + 2] ?? 0;
      data[i + 3] = looks[i + 3] ? EMISSIVE_ALPHA : 0xff;
    }
    this.#paletteTexture.needsUpdate = true;
    const intent = this.#intent;
    const intentData = this.#intentData;
    const states = Math.min(intent.length / 3, intentData.length / 4);
    for (let id = 1; id < states; id++) {
      intentData[id * 4] = intent[id * 3] ?? 0;
      intentData[id * 4 + 1] = intent[id * 3 + 1] ?? 0;
      intentData[id * 4 + 2] = intent[id * 3 + 2] ?? 0;
      intentData[id * 4 + 3] = 0xff;
    }
    this.#intentTexture.needsUpdate = true;
    this.#paletteDirty = false;
  }

  #setMesh(key: number, quads: Uint16Array, tris: Uint16Array): void {
    let meshes = this.#meshes.get(key);
    if (!meshes) {
      meshes = { quads: null, tris: null };
      this.#meshes.set(key, meshes);
    }
    const quadCount = quads.length / QUAD_WORDS;
    const triCount = tris.length / TRI_WORDS;
    this.#quads += quadCount - instances(meshes.quads);
    this.#tris += triCount - instances(meshes.tris);
    meshes.quads = this.#place(
      key,
      meshes.quads,
      "quad",
      quadCount && quadGeometry(quads, this.#size),
    );
    meshes.tris = this.#place(key, meshes.tris, "tri", triCount && triGeometry(tris, this.#size));
  }

  /** Swaps a chunk mesh's geometry, creating or removing the mesh as needed. */
  #place(
    key: number,
    mesh: THREE.Mesh | null,
    kind: SurfaceKind,
    geometry: THREE.InstancedBufferGeometry | 0,
  ): THREE.Mesh | null {
    mesh?.geometry.dispose();
    if (!geometry) {
      if (mesh) this.#faceGroup.remove(mesh);
      return null;
    }
    if (mesh) {
      mesh.geometry = geometry;
      return mesh;
    }
    const created = new THREE.Mesh(geometry, this.#material(kind));
    const [cx, cy, cz] = chunkKeyToCoords(key);
    const size = this.#size;
    created.position.set(cx * size, cy * size, cz * size);
    created.matrixAutoUpdate = false;
    created.updateMatrix();
    this.#faceGroup.add(created);
    return created;
  }

  #removeMesh(key: number): void {
    const meshes = this.#meshes.get(key);
    if (!meshes) return;
    this.#quads -= instances(meshes.quads);
    this.#tris -= instances(meshes.tris);
    this.#place(key, meshes.quads, "quad", 0);
    this.#place(key, meshes.tris, "tri", 0);
    this.#meshes.delete(key);
  }
}

/** A chunk's meshes: whole faces as quads, and sloped shaped parts as triangles. */
interface ChunkMeshes {
  quads: THREE.Mesh | null;
  tris: THREE.Mesh | null;
}

const instances = (mesh: THREE.Mesh | null) =>
  mesh ? (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0;

/** Bounds can't come from the base shape: they are the chunk's cube. */
function setChunkBounds(geometry: THREE.BufferGeometry, size: number): void {
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(size, size, size),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(size / 2, size / 2, size / 2),
    (size * Math.sqrt(3)) / 2,
  );
}

/** Instanced quads: a base square, and two normalized Uint16 vec4s per quad. */
function quadGeometry(quads: Uint16Array, size: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  // Each geometry owns its base shape: disposing a geometry frees all of its attributes.
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  const packed = new THREE.InstancedInterleavedBuffer(quads, QUAD_WORDS);
  geometry.setAttribute("quadA", new THREE.InterleavedBufferAttribute(packed, 4, 0, true));
  geometry.setAttribute("quadB", new THREE.InterleavedBufferAttribute(packed, 4, 4, true));
  geometry.instanceCount = quads.length / QUAD_WORDS;
  setChunkBounds(geometry, size);
  return geometry;
}

/** Instanced triangles: a base triangle of corner weights, three Uint16 vec4s per triangle. */
function triGeometry(tris: Uint16Array, size: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3),
  );
  const packed = new THREE.InstancedInterleavedBuffer(tris, TRI_WORDS);
  geometry.setAttribute("triA", new THREE.InterleavedBufferAttribute(packed, 4, 0, true));
  geometry.setAttribute("triB", new THREE.InterleavedBufferAttribute(packed, 4, 4, true));
  geometry.setAttribute("triC", new THREE.InterleavedBufferAttribute(packed, 4, 8, true));
  geometry.instanceCount = tris.length / TRI_WORDS;
  setChunkBounds(geometry, size);
  return geometry;
}
