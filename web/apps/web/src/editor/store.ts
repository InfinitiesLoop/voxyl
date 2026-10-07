/**
 * A value that the scene side owns and React reads (with useStore). The value is replaced,
 * never mutated, so React sees every change.
 */
export class Store<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();

  constructor(value: T) {
    this.#value = value;
  }

  get = (): T => this.#value;

  set(value: T): void {
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
