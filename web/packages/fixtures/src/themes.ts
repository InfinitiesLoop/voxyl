import { type Project, ROOT_PALETTE, type SharedPalette } from "@voxyl/core";
import { CITY_SEMANTICS, type CitySemantic } from "./city.ts";

/** The key every city theme shares, so syncing another theme re-skins the same linked palette. */
export const CITY_THEME_KEY = "voxyl.city";

export interface CityTheme {
  readonly name: string;
  /** Per semantic: a hint colour, and whether it glows. None = undecided. */
  readonly looks: Partial<Record<CitySemantic, { readonly tint: string; readonly glow?: true }>>;
}

export const CITY_THEMES: readonly CityTheme[] = [
  {
    name: "Concrete",
    looks: {
      Ground: { tint: "#2c3036" },
      Road: { tint: "#1b1d21" },
      Mass: { tint: "#3b4048" },
      Glass: { tint: "#5f8796" },
      Trim: { tint: "#c8cdd5" },
      Roof: { tint: "#545a63" },
      Glow: { tint: "#22d3ee", glow: true },
    },
  },
  {
    name: "Brick",
    looks: {
      Ground: { tint: "#6b5d4a" },
      Road: { tint: "#3a3733" },
      Mass: { tint: "#9a553a" },
      Glass: { tint: "#cdb98a" },
      Trim: { tint: "#e6d9bc" },
      Roof: { tint: "#5b3b2c" },
      Glow: { tint: "#ffb347", glow: true },
    },
  },
  { name: "Undecided", looks: {} },
];

/**
 * A city theme as a shared palette. Every theme has the same key and semantic keys, so syncing
 * one over another changes looks and nothing else: semantic ids, and so cells, stay put.
 * `version` must grow with each sync (an older version is ignored).
 */
export function cityThemePalette(theme: CityTheme, version: number): SharedPalette {
  return {
    key: CITY_THEME_KEY,
    version,
    name: "City",
    description: `The city's looks (${theme.name})`,
    semantics: CITY_SEMANTICS.map((name) => {
      const look = theme.looks[name];
      return { key: name.toLowerCase(), name, ...(look && { look: { ...look } }) };
    }),
  };
}

/**
 * Sets a project up for generateCity the way a person would: the city theme comes in as a
 * linked palette, the project's root palette extends it, and the city's semantics are derived
 * into the root palette (so generateCity finds them there by name). Re-skinning is then one
 * palette_sync of another theme.
 */
export function prepareCityProject(
  project: Project,
  theme: CityTheme = CITY_THEMES[0] as CityTheme,
) {
  const shared = cityThemePalette(theme, 1);
  project.run({ id: "city-theme", kind: "palette_sync", args: shared });
  const registry = project.semantics;
  const linked = registry.palettes().find((p) => p.linked?.key === CITY_THEME_KEY);
  if (!linked) throw new Error("the city theme didn't sync");
  project.run({
    id: "city-extends",
    kind: "palette_update",
    args: { palette: ROOT_PALETTE, extends: linked.id },
  });
  for (const name of CITY_SEMANTICS) {
    const base = registry.byName(name, linked.id);
    if (base !== undefined) registry.derive(ROOT_PALETTE, base);
  }
}
