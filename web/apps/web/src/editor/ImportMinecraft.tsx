import type { InstancePlan } from "@voxyl/mc-import";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryActions } from "../Hud.tsx";
import {
  canPickDirectory,
  ensureReadable,
  pickDirectory,
  pickedFiles,
  recallHandle,
} from "../import/fs-browser.ts";
import { Cancelled, type ImportJob, planFolder, runImport } from "../import/import-client.ts";
import {
  detectPlatform,
  launcherLocations,
  type Platform,
  vanillaJarHint,
} from "../import/locations.ts";
import type { FolderSource, ImportReport } from "../import/protocol.ts";

/** The picker remembers the folder under this name, so it opens there next time. */
const PURPOSE = "mc-instance";
const DEFAULT_PREFIX = "pack-";
/** How many mods the report lists as having entries left out. */
const LEFT_OUT_LISTED = 8;

type Route = "folder" | "jar";
type Phase = { phase: string; done: number; total: number };

const SAVING = "Saving libraries";
const ADDING = "Adding to your block libraries";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Home, Blocks, Import Minecraft: one dialog, two routes. A game folder or modpack instance is
 * read by the import worker (it never leaves this device); a Minecraft jar or resource pack is
 * the single-file import the library already had.
 */
export function ImportMinecraftDialog({
  library,
  onClose,
}: {
  library: LibraryActions;
  onClose: () => void;
}) {
  const platform: Platform = detectPlatform(navigator);
  const [route, setRoute] = useState<Route>("folder");
  const [source, setSource] = useState<FolderSource | null>(null);
  const [folderName, setFolderName] = useState("");
  const [remembered, setRemembered] = useState<FileSystemDirectoryHandle | null>(null);
  const [plan, setPlan] = useState<InstancePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [vanilla, setVanilla] = useState<File | null>(null);
  const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
  const [running, setRunning] = useState<Phase | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useRef<ImportJob<unknown> | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const vanillaInput = useRef<HTMLInputElement>(null);
  const jarInput = useRef<HTMLInputElement>(null);

  const busy = running !== null;
  const stage = running?.phase;
  const cancellable = busy && stage !== SAVING && stage !== ADDING;

  // Leaving with work in flight (the page closing a dialog) ends the worker.
  useEffect(() => () => job.current?.cancel(), []);

  useEffect(() => {
    let current = true;
    void recallHandle(PURPOSE).then((handle) => {
      if (current) setRemembered(handle);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [busy, onClose]);

  const check = useCallback((from: FolderSource) => {
    job.current?.cancel();
    setPlan(null);
    setError(null);
    setPlanning(true);
    const planned = planFolder(from);
    job.current = planned;
    planned.result.then(
      (found) => {
        if (job.current !== planned) return;
        job.current = null;
        setPlanning(false);
        if (found) setPlan(found);
        else {
          setError(
            "This doesn't look like a Minecraft game folder: it has no mods, versions or resourcepacks folder in it.",
          );
        }
      },
      (caught: unknown) => {
        if (caught instanceof Cancelled || job.current !== planned) return;
        job.current = null;
        setPlanning(false);
        setError(message(caught));
      },
    );
  }, []);

  const use = useCallback(
    (from: FolderSource, name: string) => {
      setSource(from);
      setFolderName(name);
      setReport(null);
      check(from);
    },
    [check],
  );

  const chooseFolder = () => {
    if (!canPickDirectory()) {
      folderInput.current?.click();
      return;
    }
    pickDirectory(PURPOSE, remembered).then(
      (handle) => {
        if (!handle) return;
        setRemembered(handle);
        use({ kind: "handle", handle }, handle.name);
      },
      (caught: unknown) => setError(message(caught)),
    );
  };

  const useRemembered = () => {
    if (!remembered) return;
    ensureReadable(remembered).then(
      (allowed) => {
        if (allowed) use({ kind: "handle", handle: remembered }, remembered.name);
        else setError("Voxyl wasn't allowed to read that folder. Choose it again.");
      },
      (caught: unknown) => setError(message(caught)),
    );
  };

  const start = () => {
    if (!source || !plan || plan.problems.length > 0 || busy) return;
    setError(null);
    setRunning({ phase: "Starting", done: 0, total: 0 });
    const running = runImport(
      { source, prefix, ...(vanilla && { vanillaJar: vanilla }) },
      (phase, done, total) => setRunning({ phase, done, total }),
    );
    job.current = running;
    running.result
      .then(async (done) => {
        setRunning({ phase: ADDING, done: 0, total: 0 });
        await library.reload();
        job.current = null;
        setReport(done);
        setRunning(null);
      })
      .catch((caught: unknown) => {
        job.current = null;
        setRunning(null);
        if (!(caught instanceof Cancelled)) setError(message(caught));
      });
  };

  const cancel = () => job.current?.cancel();

  const importable =
    source !== null && plan !== null && plan.problems.length === 0 && prefix.trim() !== "";

  return createPortal(
    <div className="keys">
      <button
        type="button"
        className="keys-backdrop"
        aria-label="Close"
        onClick={() => !busy && onClose()}
      />
      <div className="keys-card import-card" role="dialog" aria-label="Import Minecraft">
        <header>
          <strong>Import Minecraft</strong>
          <span>Block textures and models from your own Minecraft, kept in this browser.</span>
          <button type="button" disabled={busy} onClick={onClose}>
            {report ? "Done" : "Close"}
          </button>
        </header>
        <div className="import-body">
          <fieldset className="import-routes" aria-label="What to import">
            <button
              type="button"
              aria-pressed={route === "folder"}
              disabled={busy}
              onClick={() => setRoute("folder")}
            >
              A game folder or modpack instance
            </button>
            <button
              type="button"
              aria-pressed={route === "jar"}
              disabled={busy}
              onClick={() => setRoute("jar")}
            >
              A Minecraft jar or resource pack
            </button>
          </fieldset>
          {route === "jar" ? (
            <section className="import-step">
              <p>
                Pick a Minecraft 1.13 or newer client jar (for example{" "}
                <code>.minecraft/versions/1.21/1.21.jar</code>), or a resource pack zip. Its blocks
                become the Minecraft library.
              </p>
              <p className="home-quiet">The file is read in this browser and never uploaded.</p>
              <div className="import-row">
                <button type="button" className="primary" onClick={() => jarInput.current?.click()}>
                  Choose jar or zip…
                </button>
              </div>
              <input
                ref={jarInput}
                type="file"
                accept=".jar,.zip"
                hidden
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  e.target.value = "";
                  if (!chosen) return;
                  void library.importJar(chosen);
                  onClose();
                }}
              />
            </section>
          ) : (
            <FolderRoute
              platform={platform}
              folderName={folderName}
              hasSource={source !== null}
              handleSource={source?.kind === "handle"}
              remembered={remembered}
              plan={plan}
              planning={planning}
              vanilla={vanilla}
              prefix={prefix}
              running={running}
              report={report}
              busy={busy}
              onChoose={chooseFolder}
              onUseRemembered={useRemembered}
              onRecheck={() => source && check(source)}
              onVanilla={() => vanillaInput.current?.click()}
              onClearVanilla={() => setVanilla(null)}
              onPrefix={(value) => setPrefix(value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
            />
          )}
          {route === "folder" && error && (
            <p className="palette-error import-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <input
          ref={folderInput}
          type="file"
          // The browsers without a directory picker still give a whole folder this way.
          {...({ webkitdirectory: "" } as object)}
          multiple
          hidden
          aria-label="Choose a game folder"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length === 0) return;
            const entries = pickedFiles(files);
            const root = entries[0]?.path.split("/")[0] ?? "";
            use({ kind: "files", entries }, root);
          }}
        />
        <input
          ref={vanillaInput}
          type="file"
          accept=".jar"
          hidden
          aria-label="Choose the Minecraft jar"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (chosen) setVanilla(chosen);
          }}
        />
        {route === "folder" && (
          <footer className="entry-actions">
            <span className="topbar-gap" />
            {cancellable && (
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            )}
            {!report && (
              <button
                type="button"
                className="primary"
                disabled={!importable || busy}
                onClick={start}
              >
                Import
              </button>
            )}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

function FolderRoute(props: {
  platform: Platform;
  folderName: string;
  hasSource: boolean;
  handleSource: boolean;
  remembered: FileSystemDirectoryHandle | null;
  plan: InstancePlan | null;
  planning: boolean;
  vanilla: File | null;
  prefix: string;
  running: Phase | null;
  report: ImportReport | null;
  busy: boolean;
  onChoose: () => void;
  onUseRemembered: () => void;
  onRecheck: () => void;
  onVanilla: () => void;
  onClearVanilla: () => void;
  onPrefix: (value: string) => void;
}) {
  const { plan, running, report, busy } = props;
  const [copied, setCopied] = useState("");
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(text);
        setTimeout(() => setCopied((now) => (now === text ? "" : now)), 1500);
      },
      () => {},
    );
  };
  const offered = props.remembered && props.remembered.name !== props.folderName;
  return (
    <section className="import-step">
      <p>
        Choose the game folder of your modpack: the one with <code>mods</code> and{" "}
        <code>config</code> in it. For a launcher instance, the instance folder or its{" "}
        <code>.minecraft</code> inside both work. Voxyl only reads it, here in your browser; nothing
        is uploaded.
      </p>
      <div className="import-row">
        <button type="button" className="primary" disabled={busy} onClick={props.onChoose}>
          Choose folder…
        </button>
        {offered && props.remembered && (
          <button
            type="button"
            disabled={busy}
            title="Use the folder you picked last time"
            onClick={props.onUseRemembered}
          >
            Use {props.remembered.name} again
          </button>
        )}
        {props.hasSource && (
          <span className="import-folder" title={props.folderName}>
            {props.folderName || "Folder chosen"}
          </span>
        )}
      </div>
      {!props.hasSource && (
        <div className="import-locations">
          <p className="home-quiet">Where to look:</p>
          <ul>
            {launcherLocations(props.platform).map((where) => (
              <li key={where.label}>
                <span className="import-where">{where.label}</span>
                <code>{where.path}</code>
                <button
                  type="button"
                  title={`Copy ${where.copy}, to paste into the folder picker`}
                  onClick={() => copy(where.copy)}
                >
                  {copied === where.copy ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.planning && <p className="home-quiet">Looking through the folder…</p>}
      {plan && !report && (
        <>
          <PlanSummary
            plan={plan}
            vanilla={props.vanilla}
            onRecheck={props.handleSource ? props.onRecheck : null}
            busy={busy}
          />
          {!plan.hasVanilla && (
            <div className="import-vanilla">
              {!props.vanilla && (
                <p>
                  No Minecraft jar was found in this folder. Without it the vanilla blocks and the
                  textures many mods borrow from it are missing, so more blocks get left out.
                </p>
              )}
              <div className="import-row">
                <button type="button" disabled={busy} onClick={props.onVanilla}>
                  Add the Minecraft 1.7.10 jar…
                </button>
                {props.vanilla && (
                  <>
                    <span className="import-folder" title={props.vanilla.name}>
                      {props.vanilla.name}
                    </span>
                    <button type="button" disabled={busy} onClick={props.onClearVanilla}>
                      Remove
                    </button>
                  </>
                )}
              </div>
              <p className="home-quiet">{vanillaJarHint(props.platform)}</p>
            </div>
          )}
          <label className="import-prefix">
            Library name prefix
            <input
              value={props.prefix}
              disabled={busy}
              aria-label="Library name prefix"
              spellCheck={false}
              onChange={(e) => props.onPrefix(e.target.value)}
            />
          </label>
          <p className="home-quiet">
            Each mod becomes its own library, named with this first, such as{" "}
            <code>{props.prefix}gregtech</code>. It keeps them apart from the built-in and vanilla
            Minecraft libraries, and an import with the same prefix replaces its earlier one.
          </p>
        </>
      )}
      {running && <Progress phase={running} />}
      {report && <Report report={report} />}
    </section>
  );
}

function PlanSummary({
  plan,
  vanilla,
  onRecheck,
  busy,
}: {
  plan: InstancePlan;
  vanilla: File | null;
  onRecheck: (() => void) | null;
  busy: boolean;
}) {
  const missing = (["item", "itempanel", "block"] as const).filter((k) => !plan.dumps[k]);
  return (
    <div className="import-plan">
      <dl>
        <dt>Game folder</dt>
        <dd>{plan.gameFolder}</dd>
        <dt>Mods</dt>
        <dd>{plan.mods.toLocaleString()}</dd>
        <dt>NEI Data Dumps</dt>
        <dd>
          {missing.length === 0
            ? "item, itempanel and block are all there"
            : `missing: ${missing.map((k) => `${k}.csv`).join(", ")}`}
        </dd>
        <dt>Minecraft jar</dt>
        <dd>
          {plan.hasVanilla
            ? `found in versions (${plan.versionJars})`
            : vanilla
              ? vanilla.name
              : "not found"}
        </dd>
        <dt>Saw list</dt>
        <dd>{plan.hasMicroblocksCfg ? "microblocks.cfg found" : "none (optional)"}</dd>
      </dl>
      {plan.problems.length > 0 && (
        <div className="import-problems" role="alert">
          {plan.problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
          {onRecheck && (
            <button type="button" disabled={busy} onClick={onRecheck}>
              Check again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Progress({ phase }: { phase: Phase }) {
  const known = phase.total > 0;
  const percent = known ? Math.min(100, (phase.done / phase.total) * 100) : 0;
  return (
    <div className="import-progress">
      <div className="import-progress-label">
        <span>{phase.phase}…</span>
        {known && (
          <span>
            {phase.done.toLocaleString()} of {phase.total.toLocaleString()}
          </span>
        )}
      </div>
      <div
        className={known ? "import-bar" : "import-bar indeterminate"}
        role="progressbar"
        aria-label={phase.phase}
        aria-valuemin={0}
        aria-valuemax={phase.total}
        aria-valuenow={phase.done}
      >
        <div style={known ? { width: `${percent}%` } : undefined} />
      </div>
    </div>
  );
}

function Report({ report }: { report: ImportReport }) {
  const listed = report.droppedByMod.slice(0, LEFT_OUT_LISTED);
  const more = report.droppedByMod.length - listed.length;
  return (
    <div className="import-report">
      <p>
        <strong>
          Imported {plural(report.libraries.length, "library", "libraries")},{" "}
          {plural(report.blocks, "block")}
        </strong>{" "}
        in {(report.ms / 1000).toFixed(1)} s. They are in Home, Blocks.
      </p>
      {report.dropped > 0 ? (
        <>
          <p>
            {plural(report.dropped, "block")} from the mods' lists were left out, because no texture
            matched them with confidence. They are never guessed.
          </p>
          <ul>
            {listed.map(([mod, count]) => (
              <li key={mod}>
                <span>{mod}</span>
                <span>{count.toLocaleString()}</span>
              </li>
            ))}
            {more > 0 && (
              <li className="home-quiet">
                <span>and {plural(more, "more mod")}</span>
                <span />
              </li>
            )}
          </ul>
        </>
      ) : (
        <p>Every block in the mods' lists found its texture.</p>
      )}
      {report.healed.length > 0 && (
        <p className="home-quiet">Mod fixes applied to: {report.healed.join(", ")}.</p>
      )}
      {report.warnings > 0 && (
        <p className="home-quiet">
          {plural(report.warnings, "warning")} while reading textures; the textures concerned were
          skipped.
        </p>
      )}
    </div>
  );
}
