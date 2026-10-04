// A mesh worker: meshes chunks for the world worker. The main thread hands it a MessagePort
// to the world worker once; jobs arrive and results go back over that port.

import { meshChunk } from "@voxyl/mesher";
import type { MeshReply, MeshRequest } from "./protocol.ts";

// The app compiles with DOM types, so describe the worker scope we use rather than pulling
// in the WebWorker lib (the two conflict in one program).
interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<{ port: MessagePort }>) => void,
  ): void;
}
const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const { port } = event.data;
  port.onmessage = (e: MessageEvent<MeshRequest>) => {
    const { world, job } = e.data;
    const start = performance.now();
    const { quads, quadCount, quadBytes } = meshChunk(job);
    const reply: MeshReply = {
      world,
      result: {
        jobId: job.jobId,
        key: job.key,
        quads,
        quadCount,
        quadBytes,
        ms: performance.now() - start,
      },
    };
    port.postMessage(reply, [quads.buffer]);
  };
});
