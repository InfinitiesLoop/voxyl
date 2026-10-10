import type { SharedPalette } from "@voxyl/core";
import type { ProjectEntry, StoredPalette } from "@voxyl/session";
import { shapeName } from "@voxyl/shapes";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentsTab } from "../agent/AgentsTab.tsx";
import type { LibraryActions, ProjectActions } from "../Hud.tsx";
import type { Engine } from "../scene/Engine.ts";
import { placementName } from "../world/editing.ts";
import type { LibraryInfo, SharedPaletteInfo } from "../world/protocol.ts";
import { WORLD_KINDS, type WorldKind } from "../worlds.ts";
import { BlockChooser, blockTitle } from "./BlockPicker.tsx";
import { ImportMinecraftDialog } from "./ImportMinecraft.tsx";
import { BakedIcon } from "./icons.tsx";
import { EntryDialog, freshName } from "./PaletteEntry.tsx";
import { PrefabGrid } from "./prefabs.tsx";
import { ShapeIcon } from "./ShapeIcon.tsx";

/** The samples offered when there are no builds yet. The 20M cities stay in Samples. */
const DEMOS: readonly { kind: WorldKind; label: string }[] = [
  { kind: "blocks", label: "Block showcase" },
  { kind: "mc-blocks", label: "Minecraft blocks" },
  { kind: "city-5m", label: "City, 5M cells" },
  { kind: "parts-5m", label: "Shaped city, 5M cells" },
];

type Tab = "projects" | "palettes" | "prefabs" | "blocks" | "agents";
const TAB_KEY = "voxyl.homeTab";
const TAB_EVENT = "voxyl-home-tab";

/** Opens Home on a tab. A note's `[label](blocks)` uses this. */
export function openHomeTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // The tab still changes for this visit.
  }
  window.dispatchEvent(new Event(TAB_EVENT));
}

function readTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (
      saved === "projects" ||
      saved === "palettes" ||
      saved === "prefabs" ||
      saved === "blocks" ||
      saved === "agents"
    )
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
  useEffect(() => {
    const onTab = () => setTab(readTab());
    window.addEventListener(TAB_EVENT, onTab);
    return () => window.removeEventListener(TAB_EVENT, onTab);
  }, []);
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
              ["agents", "Agents"],
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
        {tab === "agents" && <AgentsTab />}
      </div>
    </div>
  );
}

function Projects({ projects, onOpen, onNew, onSample, project }: HomeProps) {
  const file = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState(false);
  return (
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
        <div className="home-welcome">
          <h1>
            Welcome to Voxyl
            <img src="/conduit-pillar.png" alt="" />
          </h1>
          <button type="button" className="primary welcome-start" onClick={onNew}>
            Start building
          </button>
          <p className="home-quiet">Or check out these demos</p>
          <div className="home-demos">
            {DEMOS.map((demo) => (
              <button key={demo.kind} type="button" onClick={() => onSample(demo.kind)}>
                {demo.label}
              </button>
            ))}
          </div>
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
 * A shared palette's editor: its name and description, and its semantics as the same picture
 * grid a build's inventory shows. A click opens the entry editor a build uses (name, block
 * chooser, shape, placing, colour). Saved as you go; projects that use it update when their
 * owner picks "Update" in the drawer.
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
  /** The semantic being edited by its place in the palette, or "new" for one being added. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
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
  const editingSemantic = typeof editing === "number" ? palette.semantics[editing] : undefined;
  return (
    <div className="home-pane palette-editor">
      {editing !== null && (
        <EntryDialog
          key={editing === "new" ? "new" : (editingSemantic?.key ?? editing)}
          engine={engine}
          creating={editing === "new"}
          initial={{
            name: editingSemantic?.name ?? freshName(palette.semantics.map((x) => x.name)),
            description: editingSemantic?.description ?? "",
            block: editingSemantic?.look?.block ?? null,
            glow: editingSemantic?.look?.glow ?? false,
            tint: editingSemantic?.look?.tint ?? "#9aa0a8",
            shape: editingSemantic?.form?.shape ?? null,
            placement: placementName(editingSemantic?.form?.placement),
          }}
          onSave={async ({ name, description, look, form }) => {
            const entry: SemanticDraft = {
              key: editingSemantic?.key ?? freshKey(),
              name,
              ...(description !== "" && { description }),
              ...(Object.keys(form).length > 0 && { form }),
              look,
            };
            update({
              ...palette,
              semantics:
                editing === "new"
                  ? [...palette.semantics, entry]
                  : palette.semantics.map((x, k) => (k === editing ? entry : x)),
            });
          }}
          onDelete={() => {
            if (typeof editing !== "number") return;
            update({ ...palette, semantics: palette.semantics.filter((_, k) => k !== editing) });
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
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
      <div className="inventory-grid palette-grid">
        {palette.semantics.map((s, i) => (
          <button
            key={s.key}
            type="button"
            className="inventory-swatch"
            title={[
              s.name,
              s.description,
              s.look?.block ? blockTitle(s.look.block) : "undecided",
              s.form?.shape ? shapeName(s.form.shape) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            onClick={() => setEditing(i)}
          >
            <BakedIcon
              engine={engine}
              block={s.look?.block}
              color={s.look?.tint ?? info.colors[i] ?? "#9aa0a8"}
              className={s.look?.glow ? "inventory-icon glow" : "inventory-icon"}
            />
            {s.form?.shape && <ShapeIcon shape={s.form.shape} className="inventory-shape" />}
            <span>{s.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="inventory-swatch inventory-add"
          title={`Add a semantic to ${palette.name}`}
          onClick={() => setEditing("new")}
        >
          <span className="swatch">+</span>
          <span>Add</span>
        </button>
      </div>
      <div className="home-actions">
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
  const [importing, setImporting] = useState(false);
  return (
    <section className="home-section home-blocks">
      {importing && <ImportMinecraftDialog library={library} onClose={() => setImporting(false)} />}
      <BlockChooser
        // The list of libraries is read once on mount: a new library is a new chooser.
        key={libraries.map((l) => `${l.id}:${l.blocks}`).join()}
        engine={engine}
        browse
        onImport={() => setImporting(true)}
        onRemoveMany={(items) => void library.deleteMany(items)}
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
