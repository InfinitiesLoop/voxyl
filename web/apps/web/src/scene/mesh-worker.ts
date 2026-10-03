import { meshChunk } from "@voxyl/mesher";
import type { MeshJob, MeshResult } from "./mesh-protocol.ts";

// The app compiles with DOM types, so describe the worker scope we use rather than pulling
// in the WebWorker lib (the two conflict in one program).
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<MeshJob>) => void): void;
  postMessage(message: MeshResult, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const job = event.data;
  const start = performance.now();
  const { quads, quadCount } = meshChunk(job);
  const result: MeshResult = {
    jobId: job.jobId,
    key: job.key,
    quads,
    quadCount,
    ms: performance.now() - start,
  };
  scope.postMessage(result, [quads.buffer]);
});
