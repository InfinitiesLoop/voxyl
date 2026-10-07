import { CITY_THEMES } from "@voxyl/fixtures";
import type { ProjectEntry } from "@voxyl/session";
import { useRef } from "react";
import type { Settings } from "./App.tsx";
import type { BenchResult, Distribution } from "./bench/bench.ts";
import type { Backend, EngineStats } from "./scene/Engine.ts";
import { clockLabel } from "./scene/sky-model.ts";
import type { LibraryInfo } from "./world/protocol.ts";
import { CHUNK_SIZES, savedSource, WORLD_KINDS, type WorldInfo } from "./worlds.ts";

const ms = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "–" : `${v.toFixed(digits)} ms`;
const count = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);

/** The time of day as a clock, with midnight and noon named. */
function timeLabel(hours: number): string {
  if (hours === 0 || hours === 24) return "midnight";
  if (hours === 12) return "noon";
  return clockLabel(hours);
}

/** Minecraft's names for the ends and middle of its Brightness slider. */
function brightnessLabel(brightness: number): string {
  if (brightness === 0) return "Moody";
  if (brightness === 50) return "default";
  if (brightness === 100) return "Bright";
  return `${brightness}%`;
}

interface HudProps {
  backend: Backend | null;
  stats: EngineStats | null;
  settings: Settings;
  onSettings: (s: Settings) => void;
  busy: boolean;
  /** False when the renderer fell back to WebGL, which has no light volumes. */
  volumeLighting: boolean;
  onBench: () => void;
  onHome: () => void;
  /** What is open, once loaded. */
  info: WorldInfo | null;
  projects: readonly ProjectEntry[];
  project: ProjectActions;
  /** Imported block libraries. */
  libraries: readonly LibraryInfo[];
  library: LibraryActions;
}

export function Hud({
  backend,
  stats,
  settings,
  onSettings,
  busy,
  volumeLighting,
  onBench,
  onHome,
  info,
  projects,
  project,
  libraries,
  library,
}: HudProps) {
  const f = stats?.frame;
  const c = stats?.chunks;
  const w = stats?.world;
  return (
    <aside className="hud">
      <header>
        <strong>Voxyl</strong>
        <span>{backend ?? "starting"}</span>
      </header>
      <div className="controls">
        <label>
          World
          <select
            value={settings.world}
            disabled={busy}
            onChange={(e) => onSettings({ ...settings, world: e.target.value })}
          >
            <optgroup label="Samples">
              {WORLD_KINDS.map((w) => (
                <option key={w.kind} value={w.kind}>
                  {w.label}
                </option>
              ))}
            </optgroup>
            {projects.length > 0 && (
              <optgroup label="My projects">
                {projects.map((p) => (
                  <option key={p.id} value={savedSource(p.id)}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            {/* A project saved just now, before the list catches up. */}
            {settings.world.startsWith("saved:") &&
              !projects.some((p) => savedSource(p.id) === settings.world) && (
                <option value={settings.world}>{info?.name ?? "Project"}</option>
              )}
          </select>
        </label>
        <label>
          Chunk
          <select
            value={settings.chunk}
            disabled={busy}
            onChange={(e) => onSettings({ ...settings, chunk: Number(e.target.value) })}
          >
            {CHUNK_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}³
              </option>
            ))}
          </select>
        </label>
        <label>
          Theme
          <select
            value={settings.theme}
            disabled={busy || info?.theme === null}
            onChange={(e) => onSettings({ ...settings, theme: Number(e.target.value) })}
          >
            {CITY_THEMES.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="controls">
        <label>
          Lighting
          <select
            value={settings.lighting}
            disabled={busy}
            onChange={(e) =>
              onSettings({ ...settings, lighting: e.target.value as Settings["lighting"] })
            }
          >
            <option value="off">Off</option>
            <option value="volume" disabled={!volumeLighting}>
              On
            </option>
          </select>
        </label>
        <label className="wide">
          Time of day {timeLabel(settings.time)}
          <input
            type="range"
            min={0}
            max={24}
            step={0.25}
            value={settings.time}
            onChange={(e) => onSettings({ ...settings, time: Number(e.target.value) })}
          />
        </label>
        <label className="wide">
          Brightness {brightnessLabel(settings.brightness)}
          <input
            type="range"
            min={0}
            max={100}
            value={settings.brightness}
            disabled={settings.lighting === "off"}
            onChange={(e) => onSettings({ ...settings, brightness: Number(e.target.value) })}
          />
        </label>
      </div>
      <dl>
        <dt>Frame</dt>
        <dd>
          {f ? `${f.fps.toFixed(0)} fps · p50 ${ms(f.frameP50)} · p95 ${ms(f.frameP95)}` : "–"}
        </dd>
        <dt>Main thread</dt>
        <dd>{f ? `p50 ${ms(f.cpuP50, 2)} · p95 ${ms(f.cpuP95, 2)}` : "–"}</dd>
        <dt>GPU</dt>
        <dd>
          {f?.gpuP50 != null ? `p50 ${ms(f.gpuP50, 2)} · p95 ${ms(f.gpuP95, 2)}` : "not measured"}
        </dd>
        <dt>Draws</dt>
        <dd>{f ? `${count(f.drawCalls)} calls · ${count(f.triangles)} triangles` : "–"}</dd>
        <dt>World</dt>
        <dd>
          {w && stats
            ? `${count(w.cells)} cells · ${count(w.chunkCount)} chunks of ${stats.chunkSize}³`
            : "–"}
        </dd>
        <dt>Meshes</dt>
        <dd>
          {c && w && stats
            ? `${count(c.meshes)} · ${count(c.quads)} quads${c.tris > 0 ? ` · ${count(c.tris)} tris` : ""} · ${ms(w.meshMsAvg, 2)}/chunk · ${stats.meshWorkers} workers`
            : "–"}
        </dd>
        <dt>Queue</dt>
        <dd>
          {w && c ? `${w.queued} waiting · ${w.inFlight} meshing · ${c.pending} to apply` : "–"}
        </dd>
        <dt>Memory</dt>
        <dd>
          {stats && w
            ? `chunks ${w.storageMb.toFixed(0)} MB · quads ${stats.quadMb.toFixed(1)} MB${
                stats.heapMb === null ? "" : ` · page heap ${stats.heapMb.toFixed(0)} MB`
              }`
            : "–"}
        </dd>
        <dt>Light</dt>
        <dd>
          {c && w && c.lighting !== "off"
            ? `all ${ms(w.lightAllMs, 0)} · CPU ${w.lightMb.toFixed(0)} MB · GPU ${c.lightGpuMb.toFixed(0)} MB, ${count(w.lightBricks)} bricks · copy ${w.lightCopyUs.toFixed(1)} µs/brick · write ${ms(c.lightWriteMs, 2)}/batch`
            : "off"}
        </dd>
        <dt>Timing</dt>
        <dd>
          initial mesh {ms(stats?.initialMeshMs, 0)} · last edit {ms(stats?.lastEditMs)}
        </dd>
        <dt>Speed</dt>
        <dd>{stats ? `${stats.speed.toFixed(0)} cells/s` : "–"}</dd>
      </dl>
      <ProjectRow info={info} project={project} busy={busy} />
      <LibraryRow libraries={libraries} library={library} busy={busy} />
      <div className="actions">
        <button type="button" onClick={onHome} disabled={busy}>
          Overview
        </button>
        <button
          type="button"
          aria-pressed={settings.views === "split"}
          onClick={() =>
            onSettings({ ...settings, views: settings.views === "split" ? "3d" : "split" })
          }
        >
          2D view
        </button>
        <button type="button" onClick={onBench} disabled={busy}>
          Run benchmark
        </button>
      </div>
    </aside>
  );
}

const dist = (d: Distribution) => `p50 ${ms(d.p50)} · p95 ${ms(d.p95)} · max ${ms(d.max)}`;

export interface ProjectActions {
  /** Saves the open project; a sample becomes one of "My projects". */
  save(): Promise<void>;
  export(id: string, name: string): Promise<void>;
  import(file: File): Promise<void>;
  delete(id: string, name: string): Promise<void>;
}

/** The open project's name, and saving, exporting, importing and deleting. */
function ProjectRow({
  info,
  project,
  busy,
}: {
  info: WorldInfo | null;
  project: ProjectActions;
  busy: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const saved = info?.saved ?? null;
  const name = info?.name ?? "";
  return (
    <div className="project">
      <span className="project-name" title={saved ? "Saved in this browser" : "Not saved"}>
        {info ? name : "–"}
        {info && !saved && <em> · not saved</em>}
      </span>
      {!saved && (
        <button type="button" disabled={busy || !info} onClick={() => void project.save()}>
          Save
        </button>
      )}
      {saved && (
        <>
          <button type="button" disabled={busy} onClick={() => void project.export(saved, name)}>
            Export
          </button>
          <button type="button" disabled={busy} onClick={() => void project.delete(saved, name)}>
            Delete
          </button>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => file.current?.click()}>
        Import…
      </button>
      <input
        ref={file}
        type="file"
        accept=".voxyl"
        hidden
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) void project.import(chosen);
        }}
      />
    </div>
  );
}

export interface LibraryActions {
  importJar(file: File): Promise<void>;
  delete(id: string, name: string): Promise<void>;
}

/**
 * Textures from the user's own Minecraft: import their client jar (it stays in this browser),
 * or remove it again. Looks naming "minecraft:" blocks draw in their colours until then.
 */
function LibraryRow({
  libraries,
  library,
  busy,
}: {
  libraries: readonly LibraryInfo[];
  library: LibraryActions;
  busy: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const minecraft = libraries.find((l) => l.id === "minecraft");
  return (
    <div className="project">
      <span
        className="project-name"
        title="Block textures from your own Minecraft, kept in this browser"
      >
        {minecraft ? (
          `${minecraft.name} · ${minecraft.blocks} blocks`
        ) : (
          <em>No Minecraft textures</em>
        )}
      </span>
      {minecraft && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void library.delete(minecraft.id, minecraft.name)}
        >
          Remove
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        title="Pick a client jar, e.g. .minecraft/versions/1.21/1.21.jar"
        onClick={() => file.current?.click()}
      >
        Minecraft jar…
      </button>
      <input
        ref={file}
        type="file"
        accept=".jar"
        hidden
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) void library.importJar(chosen);
        }}
      />
    </div>
  );
}

export function BenchPanel({ result, onClose }: { result: BenchResult; onClose: () => void }) {
  const copy = () => navigator.clipboard.writeText(JSON.stringify(result, null, 2));
  return (
    <section className="bench">
      <header>
        <strong>Benchmark</strong>
        <span>
          {result.world} · {count(result.cells)} cells · {result.chunkSize}³ chunks ·{" "}
          {result.backend}
        </span>
      </header>
      <table>
        <tbody>
          <tr>
            <th>Generate world</th>
            <td>{ms(result.generateMs, 0)}</td>
          </tr>
          <tr>
            <th>Initial mesh, all chunks</th>
            <td>
              {ms(result.initialMeshMs, 0)} ({count(result.chunks)} chunks, {count(result.quads)}{" "}
              quads{result.tris > 0 ? `, ${count(result.tris)} tris` : ""} in{" "}
              {result.quadMb.toFixed(0)} MB, {result.workers} workers)
            </td>
          </tr>
          <tr>
            <th>Light whole world</th>
            <td>
              {result.lighting !== "off"
                ? `${ms(result.lightAllMs, 0)} · CPU ${result.lightMb.toFixed(0)} MB · GPU ${result.lightGpuMb.toFixed(0)} MB`
                : "lighting off"}
            </td>
          </tr>
          <tr>
            <th>Flight frame time</th>
            <td>{dist(result.flight.frameMs)}</td>
          </tr>
          <tr>
            <th>Flight main thread</th>
            <td>{dist(result.flight.cpuMs)}</td>
          </tr>
          <tr>
            <th>Flight GPU time</th>
            <td>{result.flight.gpuMs.count > 0 ? dist(result.flight.gpuMs) : "not measured"}</td>
          </tr>
          <tr>
            <th>Single edit to visible</th>
            <td>
              {dist(result.singleEdits)} ({result.singleEdits.count} edits)
            </td>
          </tr>
          {result.bulk.map((b) => (
            <tr key={b.label}>
              <th>{b.label}</th>
              <td>
                {count(b.cells)} cells · write {ms(b.writeMs, 0)} · visible {ms(b.visibleMs, 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" onClick={copy}>
          Copy JSON
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
