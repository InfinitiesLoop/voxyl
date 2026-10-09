import type { InstancePlan } from "@voxyl/mc-import";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryActions } from "../Hud.tsx";
import { pickedFiles } from "../import/fs-browser.ts";
import { Cancelled, type ImportJob, planFolder, runImport } from "../import/import-client.ts";
import {
  detectPlatform,
  launcherLocations,
  type Platform,
  vanillaJarHint,
} from "../import/locations.ts";
import type { FolderSource, ImportReport } from "../import/protocol.ts";
import "./import-minecraft.css";

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
 * Home, Blocks, Import Minecraft: one dialog in numbered steps (what to import, which folder,
 * the options, the import itself). A game folder or modpack instance is read by the import
 * worker and never leaves this device; a Minecraft jar or resource pack is the single-file
 * import the library already had.
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

  const chooseFolder = () => folderInput.current?.click();

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

  const folderReady = source !== null && plan !== null && plan.problems.length === 0;
  const importable = folderReady && prefix.trim() !== "";

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
          <Step number={1} title="What do you want to import?">
            <fieldset className="import-routes" aria-label="What to import">
              <button
                type="button"
                aria-pressed={route === "folder"}
                disabled={busy}
                onClick={() => setRoute("folder")}
              >
                A modpack or game folder
                <span>The mods of a launcher instance such as GTNH, one library per mod.</span>
              </button>
              <button
                type="button"
                aria-pressed={route === "jar"}
                disabled={busy}
                onClick={() => setRoute("jar")}
              >
                Minecraft itself
                <span>A Minecraft client jar (1.13 or newer) or a resource pack zip.</span>
              </button>
            </fieldset>
            <p className="import-order">
              Doing both? Import vanilla Minecraft first, to get the Minecraft blocks, then the
              modpack for its mods.
            </p>
          </Step>
          {route === "jar" ? (
            <Step number={2} title="Choose the file">
              <p>
                Pick a Minecraft 1.13 or newer client jar (for example{" "}
                <code>.minecraft/versions/1.21/1.21.jar</code>), or a resource pack zip. Its blocks
                become the Minecraft library.
              </p>
              <p className="home-quiet">
                The file is read in this browser. It is not uploaded to any Voxyl server.
              </p>
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
            </Step>
          ) : (
            <FolderRoute
              platform={platform}
              folderName={folderName}
              hasSource={source !== null}
              plan={plan}
              planning={planning}
              vanilla={vanilla}
              prefix={prefix}
              running={running}
              report={report}
              busy={busy}
              folderReady={folderReady}
              importable={importable}
              cancellable={cancellable}
              error={error}
              onChoose={chooseFolder}
              onVanilla={() => vanillaInput.current?.click()}
              onClearVanilla={() => setVanilla(null)}
              onPrefix={(value) => setPrefix(value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
              onImport={start}
              onCancel={cancel}
            />
          )}
        </div>
        <input
          ref={folderInput}
          type="file"
          // A whole folder, read in place: the browser's own folder picker refuses places such
          // as AppData, and this one doesn't.
          {...({ webkitdirectory: "" } as object)}
          multiple
          hidden
          aria-label="Choose a game folder"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length === 0) return;
            const entries = pickedFiles(files);
            const next: FolderSource = { entries };
            setSource(next);
            setFolderName(entries[0]?.path.split("/")[0] ?? "");
            setReport(null);
            check(next);
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
      </div>
    </div>,
    document.body,
  );
}

/** One numbered step of the dialog; `state` dims a step that isn't reachable yet. */
function Step({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  state?: "waiting" | "finished" | undefined;
  children: ReactNode;
}) {
  return (
    <section className={state ? `import-step ${state}` : "import-step"}>
      <span className="import-step-number" aria-hidden="true">
        {number}
      </span>
      <h3>{title}</h3>
      <div className="import-step-body">{children}</div>
    </section>
  );
}

function FolderRoute(props: {
  platform: Platform;
  folderName: string;
  hasSource: boolean;
  plan: InstancePlan | null;
  planning: boolean;
  vanilla: File | null;
  prefix: string;
  running: Phase | null;
  report: ImportReport | null;
  busy: boolean;
  folderReady: boolean;
  importable: boolean;
  cancellable: boolean;
  error: string | null;
  onChoose: () => void;
  onVanilla: () => void;
  onClearVanilla: () => void;
  onPrefix: (value: string) => void;
  onImport: () => void;
  onCancel: () => void;
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
  return (
    <>
      <Step number={2} title="Choose the folder" state={props.folderReady ? "finished" : undefined}>
        <p>
          Choose the game folder of your modpack: the one with <code>mods</code> and{" "}
          <code>config</code> in it. For a launcher instance, the instance folder or its{" "}
          <code>.minecraft</code> inside both work.
        </p>
        <p className="home-quiet">
          <b>Nothing is uploaded to any Voxyl server.</b> Your browser's own dialog will say the
          folder's files "will be uploaded to" this site. That is its standard wording for any
          folder choice: Voxyl only reads the files here, in your browser, and keeps what it builds
          on this device.
        </p>
        <div className="import-row">
          <button type="button" className="primary" disabled={busy} onClick={props.onChoose}>
            {props.hasSource ? "Choose another folder…" : "Choose folder…"}
          </button>
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
                    title={`Copy ${where.copy}, to paste into the folder dialog`}
                    onClick={() => copy(where.copy)}
                  >
                    {copied === where.copy ? "Copied" : "Copy"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <NeiHelp />
        {props.planning && <p className="home-quiet">Looking through the folder…</p>}
        {plan && !report && (
          <PlanSummary plan={plan} vanilla={props.vanilla} busy={busy} onChoose={props.onChoose} />
        )}
        {props.error && (
          <p className="palette-error import-error" role="alert">
            {props.error}
          </p>
        )}
      </Step>
      <Step
        number={3}
        title="Name the libraries"
        state={props.folderReady ? (report ? "finished" : undefined) : "waiting"}
      >
        <label className="import-prefix">
          Library name prefix
          <input
            value={props.prefix}
            disabled={busy || !props.folderReady}
            aria-label="Library name prefix"
            spellCheck={false}
            onChange={(e) => props.onPrefix(e.target.value)}
          />
        </label>
        <p className="home-quiet">
          Each mod becomes its own library, named with this first, such as{" "}
          <code>{props.prefix}GregTech</code>. It keeps them apart from the built-in and vanilla
          Minecraft libraries. Importing again with the same prefix updates those libraries in
          place; it never adds a second copy.
        </p>
        <details className="import-help">
          <summary>Optional: add a Minecraft jar for this import</summary>
          <div className="import-help-body">
            <p>
              Not needed: the Minecraft blocks come from importing vanilla Minecraft itself (step
              1). If this pack's mods borrow textures from the Minecraft 1.7.10 jar, adding it here
              lets them find those textures too.
            </p>
            <div className="import-row">
              <button type="button" disabled={busy || !props.folderReady} onClick={props.onVanilla}>
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
        </details>
      </Step>
      <Step
        number={4}
        title="Import"
        state={report ? "finished" : props.importable ? undefined : "waiting"}
      >
        {!report && (
          <div className="import-row">
            <button
              type="button"
              className="primary"
              disabled={!props.importable || busy}
              onClick={props.onImport}
            >
              Import
            </button>
            {props.cancellable && (
              <button type="button" onClick={props.onCancel}>
                Cancel
              </button>
            )}
          </div>
        )}
        {running && <Progress phase={running} />}
        {report && <Report report={report} />}
      </Step>
    </>
  );
}

/** How to make NEI's Data Dumps, for the modpacks that have NEI (click to open). */
function NeiHelp() {
  return (
    <details className="import-help">
      <summary>Does your modpack have NEI? Make its Data Dumps first</summary>
      <div className="import-help-body">
        <p>
          Older modpacks (Minecraft 1.7.10 and before, such as GTNH) don't describe their blocks in
          a form Voxyl can read. If your modpack has NEI (Not Enough Items), its Data Dumps list
          them, and Voxyl needs three of them:
        </p>
        <ol>
          <li>
            In the game, open your inventory and click NEI's <b>Options</b>, then <b>Tools</b>, then{" "}
            <b>Data Dumps</b>.
          </li>
          <li>
            Click <b>Dump</b> beside <b>Items</b>, and beside <b>Blocks</b>.
          </li>
          <li>
            Set <b>Item Panel</b> to <b>CSV</b> (click the button until it says CSV), then click{" "}
            <b>Dump</b> beside it.
          </li>
        </ol>
        <img
          src="/nei-data-dumps.png"
          alt="NEI's Data Dumps screen: Dump buttons for Items, Blocks and Item Panel"
        />
        <p className="home-quiet">
          The files (<code>item.csv</code>, <code>block.csv</code>, <code>itempanel.csv</code>) are
          written to the <code>dumps</code> folder in the game folder. Then choose the folder here.
          A modpack without NEI can't be imported yet.
        </p>
      </div>
    </details>
  );
}

function PlanSummary({
  plan,
  vanilla,
  busy,
  onChoose,
}: {
  plan: InstancePlan;
  vanilla: File | null;
  busy: boolean;
  onChoose: () => void;
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
        {(plan.hasVanilla || vanilla) && (
          <>
            <dt>Minecraft jar</dt>
            <dd>{plan.hasVanilla ? `found in versions (${plan.versionJars})` : vanilla?.name}</dd>
          </>
        )}
        <dt>Saw list</dt>
        <dd>{plan.hasMicroblocksCfg ? "microblocks.cfg found" : "none (optional)"}</dd>
      </dl>
      {plan.problems.length > 0 && (
        <div className="import-problems" role="alert">
          {plan.problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
          <button type="button" disabled={busy} onClick={onChoose}>
            Choose the folder again…
          </button>
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
