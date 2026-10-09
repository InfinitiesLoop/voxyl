// The import worker: reads a launcher instance the user picked, turns it into block libraries
// and stores them in the same OPFS folder the world worker reads, so the editor stays
// responsive however large the pack is. A worker lives for one plan or one run; cancelling a
// run is terminating it (a library only counts once its last file is written).

import { importInstance, planInstance } from "@voxyl/mc-import";
import { LibraryStore } from "@voxyl/session";
import { OpfsFolder } from "../world/opfs-folder.ts";
import { fileEntry, filesDir, handleDir } from "./fs-browser.ts";
import type { FolderSource, FromImport, ImportReport, ToImport } from "./protocol.ts";

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<ToImport>) => void): void;
  postMessage(message: FromImport): void;
}
const scope = self as unknown as WorkerScope;
const post = (message: FromImport) => scope.postMessage(message);

/** Longest between progress messages, so a fast phase doesn't flood the page. */
const PROGRESS_MS = 60;

const dirOf = (source: FolderSource) =>
  source.kind === "handle" ? handleDir(source.handle) : filesDir(source.entries);

async function run(message: Extract<ToImport, { type: "run" }>): Promise<ImportReport> {
  let last = 0;
  const progress = (phase: string, done: number, total: number) => {
    const now = performance.now();
    if (done < total && now - last < PROGRESS_MS) return;
    last = now;
    post({ type: "progress", phase, done, total });
  };
  const result = await importInstance({
    picked: dirOf(message.source),
    prefix: message.prefix,
    ...(message.vanillaJar && {
      vanillaJar: fileEntry(message.vanillaJar, message.vanillaJar.name),
    }),
    onProgress: progress,
  });

  const store = new LibraryStore(new OpfsFolder("voxyl"));
  let saved = 0;
  progress("Saving libraries", 0, result.libraries.length);
  for (const library of result.libraries) {
    await store.save(library);
    progress("Saving libraries", ++saved, result.libraries.length);
  }

  const libraries = result.libraries.map((l) => ({
    id: l.id,
    name: l.name,
    blocks: Object.keys(l.blocks).length,
  }));
  return {
    libraries,
    blocks: libraries.reduce((sum, l) => sum + l.blocks, 0),
    dropped: result.dropped,
    droppedByMod: Object.entries(result.droppedByMod).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ),
    healed: result.healed,
    warnings: result.warnings.length,
    ms: result.ms,
  };
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  const work =
    message.type === "plan"
      ? planInstance(dirOf(message.source)).then((plan): FromImport => ({ type: "plan", plan }))
      : run(message).then((report): FromImport => ({ type: "done", report }));
  work.then(post, (error: unknown) =>
    post({ type: "error", message: error instanceof Error ? error.message : String(error) }),
  );
});
