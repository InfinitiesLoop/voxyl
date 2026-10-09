// The import worker: reads a launcher instance the user picked, turns it into block libraries
// and stores them in the same OPFS folder the world worker reads, so the editor stays
// responsive however large the pack is. A worker lives for one plan or one run; cancelling a
// run is terminating it (a library only counts once its last file is written).

import { planInstance } from "@voxyl/mc-import";
import { OpfsFolder } from "../world/opfs-folder.ts";
import { fileEntry, filesDir } from "./fs-browser.ts";
import { importAndStore } from "./import-run.ts";
import type { FolderSource, FromImport, ImportReport, ToImport } from "./protocol.ts";

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<ToImport>) => void): void;
  postMessage(message: FromImport): void;
}
const scope = self as unknown as WorkerScope;
const post = (message: FromImport) => scope.postMessage(message);

/** Longest between progress messages, so a fast phase doesn't flood the page. */
const PROGRESS_MS = 60;

const dirOf = (source: FolderSource) => filesDir(source.entries);

function run(message: Extract<ToImport, { type: "run" }>): Promise<ImportReport> {
  let last = 0;
  return importAndStore({
    picked: dirOf(message.source),
    folder: new OpfsFolder("voxyl"),
    prefix: message.prefix,
    ...(message.vanillaJar && {
      vanillaJar: fileEntry(message.vanillaJar, message.vanillaJar.name),
    }),
    onProgress: (phase, done, total) => {
      const now = performance.now();
      if (done < total && now - last < PROGRESS_MS) return;
      last = now;
      post({ type: "progress", phase, done, total });
    },
  });
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
