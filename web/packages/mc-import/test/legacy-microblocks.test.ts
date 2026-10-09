import { describe, expect, it } from "vitest";
import { isSawable, parseMicroblocksCfg } from "../src/legacy/microblocks-cfg.ts";

// An excerpt of a real GTNH 2.9 config/microblocks.cfg (header comments and one of each line
// shape: bare name, one meta, a range, a comma list).
const REAL = `#Configuration file for adding microblock materials for aesthetic blocks added by mods
#Each line needs to be of the form <name>:<meta>
#<name> is the unlocalised name or registry key of the block/item enclosed in quotes. NEI can help you find these
#<meta> may be ommitted, in which case it defaults to 0, otherwise it can be a number, a comma separated list of numbers, or a dash separated range
#Ex. "dirt" "minecraft:planks":3 "iron_ore":1,2,3,5 "ThermalFoundation:Storage":0-15

# APPLIED ENERGISTICS 2
"appliedenergistics2:tile.BlockQuartz"
"appliedenergistics2:tile.BlockQuartzGlass"

# AUTOMAGY
"Automagy:blockNetherRune":0-6

# BARTWORKS
"bartworks:bw.werkstoffblocks.01":1,4,5,7,8,9,19,20,21,22,23,24,25,32,35,36,39,40,43,64,78,88,89,90,91,92,96

# GALAXYSPACE
"GalaxySpace:futureglass":0
"GalaxySpace:ceresblocks":0,1,2,4,5

# MINECRAFT
"minecraft:double_stone_slab":0,8
"minecraft:hay_block"
`;

describe("parseMicroblocksCfg", () => {
  const cfg = parseMicroblocksCfg(REAL);

  it("reads bare names as every meta", () => {
    expect(cfg.get("appliedenergistics2:tile.BlockQuartz")).toBe(true);
    expect(cfg.get("minecraft:hay_block")).toBe(true);
    expect(isSawable(cfg, "minecraft:hay_block", 12)).toBe(true);
  });

  it("reads single metas, ranges and comma lists", () => {
    expect(cfg.get("GalaxySpace:futureglass")).toEqual([0]);
    expect(cfg.get("Automagy:blockNetherRune")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cfg.get("minecraft:double_stone_slab")).toEqual([0, 8]);
    expect(cfg.get("GalaxySpace:ceresblocks")).toEqual([0, 1, 2, 4, 5]);
    expect(cfg.get("bartworks:bw.werkstoffblocks.01")).toHaveLength(27);
  });

  it("skips comments and blank lines, and finds every entry", () => {
    expect([...cfg.keys()]).toEqual([
      "appliedenergistics2:tile.BlockQuartz",
      "appliedenergistics2:tile.BlockQuartzGlass",
      "Automagy:blockNetherRune",
      "bartworks:bw.werkstoffblocks.01",
      "GalaxySpace:futureglass",
      "GalaxySpace:ceresblocks",
      "minecraft:double_stone_slab",
      "minecraft:hay_block",
    ]);
    // The example line in the header mentions quoted names, but a comment line is not an entry.
    expect(cfg.has("dirt")).toBe(false);
  });

  it("answers whether a meta is sawable", () => {
    expect(isSawable(cfg, "minecraft:double_stone_slab", 8)).toBe(true);
    expect(isSawable(cfg, "minecraft:double_stone_slab", 1)).toBe(false);
    expect(isSawable(cfg, "Automagy:blockNetherRune", 7)).toBe(false);
    expect(isSawable(cfg, "Automagy:blockNetherRune", 6)).toBe(true);
    expect(isSawable(cfg, "minecraft:bedrock", 0)).toBe(false);
  });

  it("copes with trailing comments, spaces, CRLF and mixed lists", () => {
    const odd = parseMicroblocksCfg(
      '  "a:b" : 1-3 , 7 # trailing\r\n"c:d" # nothing after\r\n"e:f":x\r\n"g:h":5-3\r\nnot a line\r\n"broken\r\n',
    );
    expect(odd.get("a:b")).toEqual([1, 2, 3, 7]);
    expect(odd.get("c:d")).toBe(true);
    // Unreadable metas, or an empty range, leave nothing to list: every meta, as in Godot.
    expect(odd.get("e:f")).toBe(true);
    expect(odd.get("g:h")).toBe(true);
    expect(odd.has("broken")).toBe(false);
    expect(odd.size).toBe(4);
  });

  it("returns an empty whitelist for empty text", () => {
    expect(parseMicroblocksCfg("").size).toBe(0);
  });
});
