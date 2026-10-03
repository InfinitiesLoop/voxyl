import type { Settings } from "./App.tsx";
import type { BenchResult, Distribution } from "./bench/bench.ts";
import { PALETTES } from "./palettes.ts";
import type { Backend, EngineStats } from "./scene/Engine.ts";
import { CHUNK_SIZES, WORLD_KINDS, type WorldKind } from "./worlds.ts";

const ms = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? "–" : `${v.toFixed(digits)} ms`;
const count = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);

interface HudProps {
  backend: Backend | null;
  stats: EngineStats | null;
  settings: Settings;
  onSettings: (s: Settings) => void;
  busy: boolean;
  onBench: () => void;
  onHome: () => void;
}

export function Hud({ backend, stats, settings, onSettings, busy, onBench, onHome }: HudProps) {
  const f = stats?.frame;
  const c = stats?.chunks;
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
          Palette
          <select
            value={settings.palette}
            onChange={(e) => onSettings({ ...settings, palette: Number(e.target.value) })}
          >
            {PALETTES.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <dl>
        <dt>Frame</dt>
        <dd>
          {f ? `${f.fps.toFixed(0)} fps · p50 ${ms(f.frameP50)} · p95 ${ms(f.frameP95)}` : "–"}
        </dd>
        <dt>Main thread</dt>
        <dd>{f ? `p50 ${ms(f.cpuP50, 2)} · p95 ${ms(f.cpuP95, 2)}` : "–"}</dd>
        <dt>Draws</dt>
        <dd>{f ? `${count(f.drawCalls)} calls · ${count(f.triangles)} triangles` : "–"}</dd>
        <dt>World</dt>
        <dd>
          {stats
            ? `${count(stats.cells)} cells · ${count(stats.chunkCount)} chunks of ${stats.chunkSize}³`
            : "–"}
        </dd>
        <dt>Meshes</dt>
        <dd>
          {c
            ? `${count(c.meshes)} · ${count(c.quads)} quads · ${ms(c.meshMsAvg, 2)}/chunk · ${c.workers} workers`
            : "–"}
        </dd>
        <dt>Queue</dt>
        <dd>{c ? `${c.queued} waiting · ${c.inFlight} meshing` : "–"}</dd>
        <dt>Memory</dt>
        <dd>
          {stats
            ? `chunks ${stats.storageMb.toFixed(0)} MB · quads ${stats.quadMb.toFixed(1)} MB${
                stats.heapMb === null ? "" : ` · heap ${stats.heapMb.toFixed(0)} MB`
              }`
            : "–"}
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
              quads, {result.workers} workers)
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
