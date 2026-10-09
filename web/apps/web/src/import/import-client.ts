// The page's handle on the import worker: one worker per plan or run, started on demand and
// ended when it finishes or is cancelled.

import type { InstancePlan } from "@voxyl/mc-import";
import type { FolderSource, FromImport, ImportReport, ToImport } from "./protocol.ts";

export type Progress = (phase: string, done: number, total: number) => void;

export interface ImportJob<T> {
  readonly result: Promise<T>;
  /** Ends the work now. `result` rejects with a `Cancelled`. */
  cancel(): void;
}

export class Cancelled extends Error {
  override readonly name = "Cancelled";
  constructor() {
    super("Cancelled");
  }
}

function start<T>(
  message: ToImport,
  pick: (reply: FromImport) => { value: T } | null,
  onProgress?: Progress,
): ImportJob<T> {
  const worker = new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module" });
  let finish: (outcome: { value: T } | { error: Error }) => void = () => {};
  const result = new Promise<T>((resolve, reject) => {
    finish = (outcome) => {
      worker.terminate();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
  });
  worker.addEventListener("message", (event: MessageEvent<FromImport>) => {
    const reply = event.data;
    if (reply.type === "progress") onProgress?.(reply.phase, reply.done, reply.total);
    else if (reply.type === "error") finish({ error: new Error(reply.message) });
    else {
      const picked = pick(reply);
      if (picked) finish(picked);
    }
  });
  worker.addEventListener("error", (event) => finish({ error: new Error(event.message) }));
  worker.addEventListener("messageerror", () =>
    finish({ error: new Error("The folder couldn't be handed to the importer.") }),
  );
  worker.postMessage(message);
  return { result, cancel: () => finish({ error: new Cancelled() }) };
}

/** What the folder offers an import (null when it isn't a game folder). */
export function planFolder(source: FolderSource): ImportJob<InstancePlan | null> {
  return start({ type: "plan", source }, (r) => (r.type === "plan" ? { value: r.plan } : null));
}

export function runImport(
  options: { source: FolderSource; vanillaJar?: File; prefix: string },
  onProgress: Progress,
): ImportJob<ImportReport> {
  return start(
    { type: "run", ...options },
    (r) => (r.type === "done" ? { value: r.report } : null),
    onProgress,
  );
}
