import { CITY_THEMES } from "@voxyl/fixtures";
import type { Settings } from "./App.tsx";
import type { BenchResult, Distribution } from "./bench/bench.ts";
import type { Backend, EngineStats } from "./scene/Engine.ts";
import { CHUNK_SIZES, WORLD_KINDS, type WorldKind } from "./worlds.ts";

const ms = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "–" : `${v.toFixed(digits)} ms`;
const count = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);

/** Daylight as a time of day: 0 is midnight, 100 noon. */
function daylightLabel(daylight: number): string {
  if (daylight === 0) return "midnight";
  if (daylight === 100) return "noon";
  return `${daylight}%`;
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
            onChange={(e) => onSettings({ ...settings, world: e.target.value as WorldKind })}
          >
            {WORLD_KINDS.map((w) => (
              <option key={w.kind} value={w.kind}>
                {w.label}
              </option>
            ))}
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
          Time of day {daylightLabel(settings.daylight)}
          <input
            type="range"
            min={0}
            max={100}
            value={settings.daylight}
            disabled={settings.lighting === "off"}
            onChange={(e) => onSettings({ ...settings, daylight: Number(e.target.value) })}
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
      <div className="actions">
        <button type="button" onClick={onHome} disabled={busy}>
          Overview
        </button>
        <button type="button" onClick={onBench} disabled={busy}>
          Run benchmark
        </button>
      </div>
    </aside>
  );
}

const dist = (d: Distribution) => `p50 ${ms(d.p50)} · p95 ${ms(d.p95)} · max ${ms(d.max)}`;

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
