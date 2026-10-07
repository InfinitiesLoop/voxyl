// A mesh worker: meshes chunks for the world worker. The main thread hands it a MessagePort
// to the world worker once; jobs arrive and results go back over that port.

import { chunkEdges, meshChunk, ShapeTable } from "@voxyl/mesher";
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

let tableWorld = -1;
let table = new ShapeTable();

scope.addEventListener("message", (event) => {
  const { port } = event.data;
  port.onmessage = (e: MessageEvent<MeshRequest>) => {
    const request = e.data;
    if (request.world !== tableWorld) {
      tableWorld = request.world;
      table = new ShapeTable();
    }
    if ("clear" in request) {
      table.setClear(request.clear);
      table.setModels(request.models);
      return;
    }
    if (!("job" in request)) {
      table.update(request.from, request.shapes);
      return;
    }
    const { world, job } = request;
    const start = performance.now();
    const { quads, quadCount, tris, triCount, lightBricks } = meshChunk(job, table);
    const edges = job.edges ? chunkEdges(job.bits, job.cells).edges : new Uint16Array(0);
    const ms = performance.now() - start;
    const reply: MeshReply = {
      world,
      result: {
        jobId: job.jobId,
        key: job.key,
        quads,
        quadCount,
        tris,
        triCount,
        lightBricks,
        edges,
        ms,
      },
    };
    port.postMessage(reply, [quads.buffer, tris.buffer, lightBricks.buffer, edges.buffer]);
  };
});
