import { describe, expect, it } from "vitest";
import { ROOT_PALETTE, SemanticRegistry } from "../src/index.ts";

/** Factory (root) with Deck and Rail; Walkway extends it. */
function factory() {
  const r = new SemanticRegistry();
  const deck = r.add("Deck", {
    description: "Floor plates",
    look: { block: "ztones:zane", tint: "#404040" },
  });
  const rail = r.add("Rail", { form: { shape: "edge1" }, look: { block: "minecraft:iron_bars" } });
  const walkway = r.addPalette("Walkway", { extends: ROOT_PALETTE });
  return { r, deck, rail, walkway };
}

describe("SemanticRegistry", () => {
  it("starts with one root palette and keeps names unique per palette only", () => {
    const r = new SemanticRegistry();
    expect(r.palettes().map((p) => p.name)).toEqual(["Main"]);
    const a = r.add("Deck");
    expect(() => r.add("Deck")).toThrow(/already has/);
    const other = r.addPalette("Other");
    const b = r.add("Deck", { palette: other });
    expect(b).not.toBe(a);
    expect(r.byName("Deck", other)).toBe(b);
    expect(r.ensure("Deck")).toBe(a);
  });

  it("derives a parent's semantic once, inheriting everything until overridden", () => {
    const { r, deck, walkway } = factory();
    const wDeck = r.derive(walkway, deck);
    expect(r.derive(walkway, deck)).toBe(wDeck);
    expect(r.resolve(wDeck)).toMatchObject({
      name: "Deck",
      palette: walkway,
      description: "Floor plates",
      look: { block: "ztones:zane", tint: "#404040" },
    });
    // Override the block only; the tint still follows the base.
    r.update(wDeck, { look: { block: "ztones:lair" } });
    r.update(deck, { look: { block: "minecraft:stone", tint: "#808080" } });
    expect(r.resolve(wDeck).look).toEqual({ block: "ztones:lair", tint: "#808080" });
    // Renaming the base renames the derived semantic, until it takes its own name.
    r.rename(deck, "Floor");
    expect(r.nameOf(wDeck)).toBe("Floor");
    r.rename(wDeck, "Walk deck");
    r.rename(deck, "Deck");
    expect(r.nameOf(wDeck)).toBe("Walk deck");
    r.update(wDeck, { name: null });
    expect(r.nameOf(wDeck)).toBe("Deck");
    expect(() => r.update(deck, { name: null })).toThrow(/derived/);
  });

  it("derives through nearer palettes so their overrides carry down", () => {
    const { r, deck, walkway } = factory();
    const north = r.addPalette("North walkway", { extends: walkway });
    const wDeck = r.derive(walkway, deck);
    r.update(wDeck, { look: { block: "ztones:lair" } });
    const nDeck = r.derive(north, deck);
    expect(r.get(nDeck).base).toBe(wDeck);
    expect(r.resolve(nDeck).look.block).toBe("ztones:lair");
  });

  it("offers a palette's own semantics and the ones it could derive", () => {
    const { r, deck, rail, walkway } = factory();
    expect(r.offers(walkway)).toEqual([
      { name: "Deck", base: deck },
      { name: "Rail", base: rail },
    ]);
    const wDeck = r.derive(walkway, deck);
    const own = r.add("Lamp", { palette: walkway });
    expect(r.offers(walkway)).toEqual([
      { name: "Deck", id: wDeck },
      { name: "Lamp", id: own },
      { name: "Rail", base: rail },
    ]);
  });

  it("groups semantics by palette, optionally with descendants", () => {
    const { r, deck, rail, walkway } = factory();
    const wDeck = r.derive(walkway, deck);
    expect(r.semanticsIn(walkway)).toEqual([wDeck]);
    expect(r.semanticsIn(ROOT_PALETTE)).toEqual([deck, rail]);
    expect(r.semanticsIn(ROOT_PALETTE, true)).toEqual([deck, rail, wDeck]);
  });

  it("refuses cycles and re-parenting that would orphan derived semantics", () => {
    const { r, deck, walkway } = factory();
    expect(() => r.updatePalette(ROOT_PALETTE, { extends: walkway })).toThrow(/descendant/);
    r.derive(walkway, deck);
    const other = r.addPalette("Other");
    expect(() => r.updatePalette(walkway, { extends: other })).toThrow(/no longer extend/);
    expect(() => r.derive(other, deck)).toThrow(/doesn't extend/);
  });

  it("clones independently and restores exactly", () => {
    const { r, deck } = factory();
    const copy = r.clone();
    r.rename(deck, "Floor");
    expect(copy.nameOf(deck)).toBe("Deck");
    const revision = r.revision;
    r.restore(copy);
    expect(r.nameOf(deck)).toBe("Deck");
    expect(r.revision).toBeLessThan(revision);
  });
});
