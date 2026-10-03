import { World } from "@voxyl/core";

// A stand-in build and palette for the shell, until Phase 0 brings real fixtures.
// The palette lives here in the app, apart from the world: cells only know their semantic.

export const DEMO_PALETTE: Readonly<Record<string, string>> = {
  Mass: "#3b4048",
  Trim: "#c8cdd5",
  Glow: "#22d3ee",
};

/** A small pillar: a hollow dark shaft with light bands every fourth layer and glowing corners. */
export function buildDemoWorld(): World {
  const world = new World();
  const half = 4;
  const height = 17;
  for (let y = 0; y < height; y++) {
    const band = y % 4 === 0;
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const edge = Math.abs(x) === half || Math.abs(z) === half;
        const corner = Math.abs(x) === half && Math.abs(z) === half;
        if (!edge) {
          continue;
        }
        const semantic = band ? "Trim" : corner ? "Glow" : "Mass";
        world.set(x, y, z, { semantic });
      }
    }
  }
  return world;
}
