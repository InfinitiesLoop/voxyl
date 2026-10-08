import type { SharedPalette } from "@voxyl/core";
import type { ProjectEntry, StoredPalette } from "@voxyl/session";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryActions, ProjectActions } from "../Hud.tsx";
import type { Engine } from "../scene/Engine.ts";
import type { LibraryInfo, SharedPaletteInfo } from "../world/protocol.ts";
import { WORLD_KINDS, type WorldKind } from "../worlds.ts";
import { BlockChooser, BlockChooserDialog, blockTitle } from "./BlockPicker.tsx";
import { FormCell } from "./FormCell.tsx";
import { PrefabGrid } from "./prefabs.tsx";

type Tab = "projects" | "palettes" | "prefabs" | "blocks";
const TAB_KEY = "voxyl.homeTab";

function readTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === "projects" || saved === "palettes" || saved === "prefabs" || saved === "blocks")
      return saved;
  } catch {
    // Projects is where most visits start.
  }
  return "projects";
}

export interface HomeProps {
  engine: Engine;
  projects: readonly ProjectEntry[];
  /** The build open behind Home, if any, by name: Home can go back to it. */
  openName: string | null;
  onBack: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSample: (kind: WorldKind) => void;
  project: ProjectActions;
  libraries: readonly LibraryInfo[];
  library: LibraryActions;
}

/**
 * Where the app opens: your builds, your shared palettes, and the block libraries in this
 * browser. Everything here lives outside any one project. With no builds yet, it offers a
 * link straight into a new one.
 */
export function Home(props: HomeProps) {
  const [tab, setTab] = useState<Tab>(readTab);
  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering the tab is only a convenience.
    }
  };
  return (
    <div className="home">
      <header className="home-head">
        <strong className="brand">
          <img className="brand-mark" src="/conduit-pillar.png" alt="" />
          Voxyl
        </strong>
        <nav className="home-tabs" aria-label="Home">
          {(
            [
              ["projects", "Builds"],
              ["palettes", "Palettes"],
              ["prefabs", "Prefabs"],
              ["blocks", "Blocks"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="topbar-gap" />
        {props.openName !== null && (
          <button type="button" onClick={props.onBack}>
            Back to {props.openName}
          </button>
        )}
      </header>
      <div className={tab === "blocks" ? "home-body home-body-blocks" : "home-body"}>
        {tab === "projects" && <Projects {...props} />}
        {tab === "palettes" && <Palettes engine={props.engine} />}
        {tab === "prefabs" && <Prefabs engine={props.engine} onUse={props.onBack} />}
        {tab === "blocks" && (
          <Blocks engine={props.engine} libraries={props.libraries} library={props.library} />
        )}
      </div>
    </div>
  );
}

function Projects({ projects, onOpen, onNew, onSample, project }: HomeProps) {
  const file = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState(false);
  return (
    <>
      <Horizon />
      <section className="home-section">
        <div className="home-actions">
          <button type="button" className="primary" onClick={onNew}>
            New build
          </button>
          <button type="button" onClick={() => file.current?.click()}>
            Import a .voxyl file…
          </button>
          <button type="button" aria-expanded={samples} onClick={() => setSamples(!samples)}>
            Samples
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
        {samples && (
          <div className="home-samples">
            {WORLD_KINDS.map((w) => (
              <button key={w.kind} type="button" onClick={() => onSample(w.kind)}>
                {w.label}
              </button>
            ))}
          </div>
        )}
        {projects.length === 0 ? (
          <div className="home-empty">
            <p>No builds in this browser yet.</p>
            <button type="button" className="primary big" onClick={onNew}>
              Start building
            </button>
            <p className="home-quiet">
              A new build starts with a few semantics (Wall, Floor, Roof, …) already on blocks.
              Change any of them later without touching what you built.
            </p>
          </div>
        ) : (
          <ul className="home-cards">
            {[...projects]
              .sort((a, b) => b.savedAt - a.savedAt)
              .map((p) => (
                <li key={p.id} className="home-card">
                  <button type="button" className="home-card-open" onClick={() => onOpen(p.id)}>
                    <strong className="home-card-name">{p.name}</strong>
                    <span className="home-card-meta">
                      {p.cells.toLocaleString()} cells · {sizeLabel(p.bytes)} · {ago(p.savedAt)}
                    </span>
                  </button>
                  <span className="home-card-tools">
                    <button type="button" onClick={() => void project.export(p.id, p.name)}>
                      Export
                    </button>
                    <button type="button" onClick={() => void project.delete(p.id, p.name)}>
                      Delete
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** The conduit pillar, standing on a grid that runs out to the horizon. */
function Horizon() {
  return (
    <div className="horizon">
      <div className="horizon-sky" />
      <div className="horizon-ground">
        <div className="horizon-floor" />
      </div>
      <img className="horizon-pillar" src="/conduit-pillar.png" alt="" />
      <p className="horizon-caption">Build first. Decide later.</p>
    </div>
  );
}

/** Prefabs: pieces kept from builds, each a picture. Click one to paste it into the open build. */
function Prefabs({ engine, onUse }: { engine: Engine; onUse: () => void }) {
  const [query, setQuery] = useState("");
  return (
    <section className="home-section">
      <div className="home-actions">
        <input
          className="inventory-search"
          value={query}
          placeholder="Search by name or tag"
          aria-label="Search prefabs"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="home-quiet">
          Select part of a build and press Ctrl+P to keep it here. Click a prefab to paste it.
        </span>
      </div>
      <PrefabGrid engine={engine} query={query} manage onUse={onUse} />
    </section>
  );
}

/** Shared palettes: a list, and the chosen one's editor. */
function Palettes({ engine }: { engine: Engine }) {
  const [list, setList] = useState<SharedPaletteInfo[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const refresh = useCallback(
    () => void engine.world.request({ type: "sharedPalettes" }).then(setList, () => setList([])),
    [engine],
  );
  useEffect(refresh, [refresh]);
  const create = async () => {
    const saved = await engine.world.request({
      type: "saveSharedPalette",
      palette: { key: freshKey(), name: "New palette", semantics: [] },
    });
    refresh();
    setKey(saved.key);
  };
  const chosen = list.find((p) => p.key === key) ?? null;
  return (
    <section className="home-section home-split">
      <div className="home-list">
        <div className="home-actions">
          <button type="button" className="primary" onClick={() => void create()}>
            New palette
          </button>
        </div>
        {list.length === 0 && (
          <p className="home-quiet">
            No shared palettes yet. Make one here, or Share a palette from a build's palette drawer.
            A build uses one through "Use a shared palette" in its drawer.
          </p>
        )}
        <ul>
          {list.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                className="home-palette"
                aria-pressed={p.key === key}
                onClick={() => setKey(p.key)}
              >
                <strong>{p.name}</strong>
                <span className="home-strip">
                  {p.colors.slice(0, 12).map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: colours repeat; order is fixed
                    <span key={i} className="home-chip" style={{ background: c }} />
                  ))}
                </span>
                <small className="home-sub">
                  {p.count} semantics · v{p.version}
                  {p.from ? ` · from ${p.from}` : ""}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {chosen ? (
        <PaletteEditor
          key={chosen.key}
          engine={engine}
          info={chosen}
          onChanged={refresh}
          onDeleted={() => {
            setKey(null);
            refresh();
          }}
        />
      ) : (
        <p className="home-quiet home-pane">Choose a palette to edit it.</p>
      )}
    </section>
  );
}

type SemanticDraft = SharedPalette["semantics"][number];

/**
 * A shared palette's editor: its name and description, and each semantic's name, what it is
 * for, its block and its fallback colour. Saved as you go; projects that use it update when
 * their owner picks "Update" in the drawer.
 */
function PaletteEditor({
  engine,
  info,
  onChanged,
  onDeleted,
}: {
  engine: Engine;
  info: SharedPaletteInfo;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [palette, setPalette] = useState<StoredPalette | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  useEffect(() => {
    void engine.world.request({ type: "sharedPalette", key: info.key }).then(setPalette);
  }, [engine, info.key]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = (next: StoredPalette) => {
    setPalette(next);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      const { version: _v, updated: _u, ...content } = next;
      void engine.world.request({ type: "saveSharedPalette", palette: content }).then(onChanged);
    }, 400);
  };
  if (!palette) return <p className="home-quiet home-pane">Loading…</p>;
  const setSemantic = (i: number, patch: Partial<SemanticDraft>) =>
    update({
      ...palette,
      semantics: palette.semantics.map((s, k) => (k === i ? { ...s, ...patch } : s)),
    });
  const pickingSemantic = picking === null ? undefined : palette.semantics[picking];
  return (
    <div className="home-pane palette-editor">
      {picking !== null && pickingSemantic && (
        <BlockChooserDialog
          engine={engine}
          title={`Block for ${pickingSemantic.name}`}
          current={pickingSemantic.look?.block ?? null}
          onClose={() => setPicking(null)}
          onPick={(ref) => {
            const { block: _b, ...rest } = pickingSemantic.look ?? {};
            setSemantic(picking, { look: ref ? { ...rest, block: ref } : rest });
          }}
        />
      )}
      <label>
        Name
        <input
          value={palette.name}
          onChange={(e) => update({ ...palette, name: e.target.value || palette.name })}
        />
      </label>
      <label>
        What it is for
        <textarea
          rows={2}
          value={palette.description ?? ""}
          placeholder="A line on when to use this palette"
          onChange={(e) => update({ ...palette, description: e.target.value })}
        />
      </label>
      <table className="palette-table">
        <thead>
          <tr>
            <th>Look</th>
            <th>Name</th>
            <th>What it is for</th>
            <th>Shape</th>
            <th>Fallback</th>
            <th>Glows</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {palette.semantics.map((s, i) => (
            <tr key={s.key}>
              <td>
                <button type="button" className="palette-look" onClick={() => setPicking(i)}>
                  <span className="swatch" style={{ background: info.colors[i] ?? s.look?.tint }} />
                  {s.look?.block ? blockTitle(s.look.block) : "Undecided"}
                </button>
              </td>
              <td>
                <input
                  value={s.name}
                  onChange={(e) => setSemantic(i, { name: e.target.value || s.name })}
                />
              </td>
              <td>
                <input
                  value={s.description ?? ""}
                  placeholder="What it is for"
                  onChange={(e) => setSemantic(i, { description: e.target.value })}
                />
              </td>
              <td>
                <FormCell
                  form={s.form}
                  onChange={(form) => {
                    // Setting a form replaces it whole, so drop the key when it is empty.
                    const { form: _f, ...rest } = s;
                    update({
                      ...palette,
                      semantics: palette.semantics.map((x, k) =>
                        k === i ? (form ? { ...rest, form } : rest) : x,
                      ),
                    });
                  }}
                />
              </td>
              <td>
                <input
                  type="color"
                  value={s.look?.tint ?? "#8a8f98"}
                  onChange={(e) => setSemantic(i, { look: { ...s.look, tint: e.target.value } })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={s.look?.glow === true}
                  onChange={(e) => setSemantic(i, { look: { ...s.look, glow: e.target.checked } })}
                />
              </td>
              <td>
                <button
                  type="button"
                  title="Remove from this palette (projects keep theirs until they update)"
                  onClick={() =>
                    update({ ...palette, semantics: palette.semantics.filter((_, k) => k !== i) })
                  }
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="home-actions">
        <button
          type="button"
          onClick={() =>
            update({
              ...palette,
              semantics: [
                ...palette.semantics,
                { key: freshKey(), name: `Semantic ${palette.semantics.length + 1}` },
              ],
            })
          }
        >
          Add a semantic
        </button>
        <span className="topbar-gap" />
        <button
          type="button"
          onClick={() =>
            void engine.world
              .request({
                type: "saveSharedPalette",
                palette: {
                  key: freshKey(),
                  name: `${palette.name} copy`,
                  ...(palette.description !== undefined && { description: palette.description }),
                  semantics: palette.semantics,
                },
              })
              .then(onChanged)
          }
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirm(`Delete ${palette.name}? Projects that use it keep their copy.`)) return;
            void engine.world
              .request({ type: "deleteSharedPalette", key: palette.key })
              .then(onDeleted);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Block libraries in this browser. An import is a library (the built-in set is the other
 * one), so they are one list: the chooser's rail, with import and remove on it.
 */
function Blocks({
  engine,
  libraries,
  library,
}: {
  engine: Engine;
  libraries: readonly LibraryInfo[];
  library: LibraryActions;
}) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <section className="home-section home-blocks">
      <input
        ref={file}
        type="file"
        accept=".jar,.zip"
        hidden
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) void library.importJar(chosen);
        }}
      />
      <BlockChooser
        engine={engine}
        browse
        onImport={() => file.current?.click()}
        onRemove={(id, name) => void library.delete(id, name)}
        removable={new Set(libraries.map((l) => l.id))}
      />
    </section>
  );
}

function freshKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString();
}
