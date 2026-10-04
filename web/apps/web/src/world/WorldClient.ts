import type { Command, FromWorld, Replies, ToWorld, Vec3 } from "./protocol.ts";

type Output = Exclude<FromWorld, { type: "reply" } | { type: "error" }>;

/**
 * The main thread's handle on the world worker. Starts it and the mesh workers, connects
 * each mesh worker to it with its own MessagePort, and turns commands into promises. Every
 * other message (meshes, light, states, idle, stats) goes to `onOutput` in arrival order.
 */
export class WorldClient {
  readonly meshWorkers: number;
  readonly #worker: Worker;
  readonly #meshWorkers: Worker[];
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #seq = 0;

  constructor(meshWorkers: number, onOutput: (message: Output) => void) {
    this.meshWorkers = meshWorkers;
    this.#worker = new Worker(new URL("./world-worker.ts", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", (event: MessageEvent<FromWorld>) => {
      const message = event.data;
      if (message.type === "reply" || message.type === "error") {
        const pending = this.#pending.get(message.seq);
        this.#pending.delete(message.seq);
        if (message.type === "reply") pending?.resolve(message.value);
        else pending?.reject(new Error(message.message));
      } else {
        onOutput(message);
      }
    });
    this.#meshWorkers = [];
    const ports: MessagePort[] = [];
    for (let i = 0; i < meshWorkers; i++) {
      const worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), { type: "module" });
      const channel = new MessageChannel();
      worker.postMessage({ port: channel.port2 }, [channel.port2]);
      ports.push(channel.port1);
      this.#meshWorkers.push(worker);
    }
    this.#post({ type: "meshPorts", ports }, ports);
  }

  /** The sequence number of the last command sent: idle once the worker reports it. */
  get sentSeq(): number {
    return this.#seq;
  }

  request<T extends Command["type"]>(command: Extract<Command, { type: T }>): Promise<Replies[T]> {
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(seq, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ seq, ...command } as ToWorld);
    });
  }

  /** Where the camera is, so the nearest chunks are meshed first. */
  camera(at: Vec3): void {
    this.#post({ type: "camera", at });
  }

  /** Stops the workers. Commands still waiting never settle: nothing should act on them. */
  dispose(): void {
    this.#worker.terminate();
    for (const worker of this.#meshWorkers) worker.terminate();
    this.#pending.clear();
  }

  #post(message: ToWorld, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer);
  }
}

export type WorldOutput = Output;
