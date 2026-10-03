/** A growable FIFO of cells (x, y, z, plus one small value) in typed arrays. */
export class Queue {
  #xs = new Int32Array(1 << 14);
  #ys = new Int32Array(1 << 14);
  #zs = new Int32Array(1 << 14);
  #vs = new Uint8Array(1 << 14);
  #head = 0;
  #tail = 0;
  /** The cell most recently popped. */
  x = 0;
  y = 0;
  z = 0;
  v = 0;

  get size(): number {
    return this.#tail - this.#head;
  }

  clear(): void {
    this.#head = 0;
    this.#tail = 0;
  }

  push(x: number, y: number, z: number, v: number): void {
    if (this.#tail === this.#xs.length) this.#grow();
    const t = this.#tail++;
    this.#xs[t] = x;
    this.#ys[t] = y;
    this.#zs[t] = z;
    this.#vs[t] = v;
  }

  /** Pops the oldest cell into x, y, z and v. */
  pop(): void {
    const h = this.#head++;
    this.x = this.#xs[h] ?? 0;
    this.y = this.#ys[h] ?? 0;
    this.z = this.#zs[h] ?? 0;
    this.v = this.#vs[h] ?? 0;
    if (this.#head === this.#tail) this.clear();
  }

  #grow(): void {
    // Reclaim the consumed front first; only double when the queue is genuinely full.
    const live = this.#tail - this.#head;
    const capacity = live * 2 > this.#xs.length ? this.#xs.length * 2 : this.#xs.length;
    const move = <T extends Int32Array | Uint8Array>(from: T, make: (n: number) => T): T => {
      const to = make(capacity);
      to.set(from.subarray(this.#head, this.#tail));
      return to;
    };
    this.#xs = move(this.#xs, (n) => new Int32Array(n));
    this.#ys = move(this.#ys, (n) => new Int32Array(n));
    this.#zs = move(this.#zs, (n) => new Int32Array(n));
    this.#vs = move(this.#vs, (n) => new Uint8Array(n));
    this.#head = 0;
    this.#tail = live;
  }
}
