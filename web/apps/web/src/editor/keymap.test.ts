import { afterEach, describe, expect, it } from "vitest";
import {
  anyCustomized,
  DEFAULT_KEYMAP,
  isCustomized,
  isKey,
  KEYMAP,
  resetKeys,
  setKey,
  sharing,
} from "./keymap.ts";

afterEach(() => resetKeys());

describe("rebinding keys", () => {
  it("moves an action to the new key at once, and frees the old one", () => {
    expect(isKey("inventory", "KeyE")).toBe(true);
    setKey("inventory", "binding", "KeyI");
    expect(isKey("inventory", "KeyI")).toBe(true);
    expect(isKey("inventory", "KeyE")).toBe(false);
    // The alternate is untouched.
    expect(isKey("inventory", "Delete")).toBe(true);
    expect(isCustomized("inventory")).toBe(true);
    expect(anyCustomized()).toBe(true);
  });

  it("clears an alternate, but a binding always keeps a key", () => {
    setKey("inventory", "alternate", null);
    expect(KEYMAP.inventory.alternate).toEqual([]);
    setKey("inventory", "binding", null);
    expect(KEYMAP.inventory.binding).toEqual(["KeyE"]);
  });

  it("refuses Escape, which lets go of the pointer", () => {
    setKey("inventory", "binding", "Escape");
    expect(KEYMAP.inventory.binding).toEqual(["KeyE"]);
  });

  it("says which other actions already use a key", () => {
    // R turns a block, and Num 0 is its alternate: binding another action to R shares it.
    expect(setKey("inventory", "alternate", "KeyR")).toEqual(["rotateBlock"]);
    expect(sharing("rotateBlock", "KeyR")).toEqual(["inventory"]);
    expect(setKey("inventory", "alternate", "KeyJ")).toEqual([]);
  });

  it("goes back to the defaults, one action or all", () => {
    setKey("inventory", "binding", "KeyI");
    setKey("nextTool", "binding", "KeyT");
    resetKeys("inventory");
    expect(KEYMAP.inventory).toEqual(DEFAULT_KEYMAP.inventory);
    expect(isCustomized("nextTool")).toBe(true);
    resetKeys();
    expect(anyCustomized()).toBe(false);
  });
});
