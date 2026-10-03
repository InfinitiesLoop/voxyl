// A millisecond clock that works in browsers, workers and Node without their type libraries.
const perf = (globalThis as { performance?: { now(): number } }).performance;

export const now = (): number => (perf ? perf.now() : Date.now());
