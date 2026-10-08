import { type Project, ROOT_PALETTE, type SemanticRegistry, type SharedPalette } from "@voxyl/core";
import { CITY_PARTS, CITY_SEMANTICS, type CitySemantic, partKey } from "./city.ts";

/** The key every city theme shares, so syncing another theme re-skins the same linked palette. */
export const CITY_THEME_KEY = "voxyl.city";

export interface CityTheme {
  readonly name: string;
  /**
   * Per semantic: a hint colour, a block, and whether it glows. A semantic with no look is
   * undecided; no shipped theme leaves one (see the tests), but a project can.
   */
  readonly looks: Partial<
    Record<CitySemantic, { readonly tint: string; readonly block?: string; readonly glow?: true }>
  >;
}

export const CITY_THEMES: readonly CityTheme[] = [
  // The city's themes are made of the default block set, so a sample is textured out of the
  // box. The tints are only how a look draws where its block isn't available.
  {
    name: "Concrete",
    looks: {
      Ground: { tint: "#373a3f", block: "voxyl:gray_concrete" },
      Road: { tint: "#1b1d21", block: "voxyl:black_concrete" },
      Mass: { tint: "#8d8f94", block: "voxyl:light_gray_concrete" },
      Glass: { tint: "#a9d8e8", block: "voxyl:glass" },
      Trim: { tint: "#d9d4c7", block: "voxyl:white_concrete" },
      Roof: { tint: "#373a3f", block: "voxyl:gray_concrete" },
      Glow: { tint: "#22d3ee", block: "voxyl:cyan_concrete", glow: true },
    },
  },
  {
    name: "Brick",
    looks: {
      Ground: { tint: "#7a5a3a", block: "voxyl:dirt" },
      Road: { tint: "#6b6b6b", block: "voxyl:cobblestone" },
      Mass: { tint: "#9a553a", block: "voxyl:bricks" },
      Glass: { tint: "#c9e3e8", block: "voxyl:glass" },
      Trim: { tint: "#dbd0a0", block: "voxyl:sandstone" },
      Roof: { tint: "#4a3623", block: "voxyl:dark_oak_planks" },
      Glow: { tint: "#ffd27a", block: "voxyl:glowstone", glow: true },
    },
  },
  {
    // A mix of the default library's materials.
    name: "Blocks",
    looks: {
      Ground: { tint: "#689c3b", block: "voxyl:grass_block" },
      Road: { tint: "#383b3f", block: "voxyl:gray_concrete" },
      Mass: { tint: "#7b7b7b", block: "voxyl:stone_bricks" },
      Glass: { tint: "#c9e3e8", block: "voxyl:glass" },
      Trim: { tint: "#e9e3da", block: "voxyl:quartz_block" },
      Roof: { tint: "#6f5334", block: "voxyl:spruce_planks" },
      Glow: { tint: "#ffd27a", block: "voxyl:glowstone", glow: true },
    },
  },
  {
    // The same in Minecraft's own blocks: textured once the user imports their jar, drawn in
    // the tints until then.
    name: "Minecraft",
    looks: {
      Ground: { tint: "#689c3b", block: "minecraft:grass_block" },
      Road: { tint: "#383b3f", block: "minecraft:gray_concrete" },
      Mass: { tint: "#7b7b7b", block: "minecraft:stone_bricks" },
      Glass: { tint: "#c9e3e8", block: "minecraft:glass" },
      Trim: { tint: "#e9e3da", block: "minecraft:quartz_block" },
      Roof: { tint: "#6f5334", block: "minecraft:spruce_planks" },
      Glow: { tint: "#ffd27a", block: "minecraft:sea_lantern", glow: true },
    },
  },
];

/**
 * A city theme as a shared palette. Every theme has the same key and semantic keys, so syncing
 * one over another changes looks and nothing else: semantic ids, and so cells, stay put.
 * `version` must grow with each sync (an older version is ignored). With `parts`, the shaped
 * parts of a decorated city come too, each looking like the block it is a part of.
 */
export function cityThemePalette(theme: CityTheme, version: number, parts = false): SharedPalette {
  return {
    key: CITY_THEME_KEY,
    version,
    name: "City",
    description: `The city's looks (${theme.name})`,
    semantics: [
      ...CITY_SEMANTICS.map((name) => {
        const look = theme.looks[name];
        return { key: name.toLowerCase(), name, ...(look && { look: { ...look } }) };
      }),
      ...(parts ? CITY_PARTS : []).map((part) => {
        const look = theme.looks[part.of];
        return {
          key: partKey(part),
          name: part.name,
          form: { shape: part.shape },
          ...(look && { look: { ...look } }),
        };
      }),
    ],
  };
}

/**
 * Sets a project up for generateCity the way a person would: the city theme comes in as a
 * linked palette, the project's root palette extends it, and the city's semantics are derived
 * into the root palette (so generateCity finds them there by name). Re-skinning is then one
 * palette_sync of another theme. `parts` brings the shaped parts of a decorated city along.
 */
export function prepareCityProject(
  project: Project,
  theme: CityTheme = CITY_THEMES[0] as CityTheme,
  parts = false,
) {
  const shared = cityThemePalette(theme, 1, parts);
  project.run({ id: "city-theme", kind: "palette_sync", args: shared });
  const registry = project.semantics;
  const linked = registry.palettes().find((p) => p.linked?.key === CITY_THEME_KEY);
  if (!linked) throw new Error("the city theme didn't sync");
  project.run({
    id: "city-extends",
    kind: "palette_update",
    args: { palette: ROOT_PALETTE, extends: linked.id },
  });
  const names = [...CITY_SEMANTICS, ...(parts ? CITY_PARTS.map((part) => part.name) : [])];
  for (const name of names) {
    const base = registry.byName(name, linked.id);
    if (base !== undefined) registry.derive(ROOT_PALETTE, base);
  }
}

/**
 * Which of CITY_THEMES a project's linked city palette currently shows, by comparing looks; null
 * when it has no city palette or its looks match none.
 */
export function cityThemeOf(registry: SemanticRegistry): number | null {
  const linked = registry.palettes().find((p) => p.linked?.key === CITY_THEME_KEY);
  if (!linked) return null;
  const index = CITY_THEMES.findIndex((theme) =>
    CITY_SEMANTICS.every((name) => {
      const id = registry.byName(name, linked.id);
      const look = id === undefined ? {} : registry.resolve(id).look;
      const want = theme.looks[name];
      return look.tint === want?.tint && look.block === want?.block && !!look.glow === !!want?.glow;
    }),
  );
  return index < 0 ? null : index;
}
