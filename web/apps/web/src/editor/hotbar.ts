// The hotbar: nine slots of semantics, one of them chosen. It holds semantics, never blocks
// (principle 1): a slot is "Wall", and what Wall looks like comes from the palettes, so a
// re-skin changes the swatches and never the slots. Editor state, not project state.

import type { PaletteInfo, SemanticInfo } from "../world/editing.ts";
import { Store } from "./store.ts";

export const HOTBAR_SLOTS = 9;

export interface HotbarState {
  readonly slots: readonly (SemanticInfo | null)[];
  readonly selected: number;
}

const EMPTY: HotbarState = { slots: Array(HOTBAR_SLOTS).fill(null), selected: 0 };

/** True if `info` is what a slot holding `slot` now stands for. */
function sameSemantic(slot: SemanticInfo, info: SemanticInfo): boolean {
  if (typeof slot.ref === "number") return info.ref === slot.ref;
  // Not derived yet when it went in the slot: the palette's own semantic once it is.
  return info.palette === slot.ref.palette && info.base === slot.ref.base;
}

export class Hotbar {
  readonly state = new Store<HotbarState>(EMPTY);

  /** The chosen slot's semantic, if any. */
  get current(): SemanticInfo | null {
    const { slots, selected } = this.state.get();
    return slots[selected] ?? null;
  }

  select(slot: number): void {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return;
    this.state.set({ ...this.state.get(), selected: slot });
  }

  /** Steps the chosen slot forward or back, wrapping around. */
  cycle(step: number): void {
    const { selected } = this.state.get();
    this.select((((selected + step) % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS);
  }

  /** Empties every slot (another project opened). */
  clear(): void {
    this.state.set(EMPTY);
  }

  /**
   * Brings the slots up to date with the project's palettes: new names and colours, derived
   * semantics in place of the bases they came from, and semantics gone from the registry
   * dropped. An empty hotbar is filled with what the root palette offers first.
   */
  update(palettes: readonly PaletteInfo[]): void {
    const { slots, selected } = this.state.get();
    if (slots.every((s) => s === null)) {
      const offered = palettes[0]?.semantics ?? [];
      const filled = Array.from({ length: HOTBAR_SLOTS }, (_, i) => offered[i] ?? null);
      this.state.set({ slots: filled, selected });
      return;
    }
    const all = palettes.flatMap((p) => p.semantics);
    const next = slots.map((slot) =>
      slot ? (all.find((i) => sameSemantic(slot, i)) ?? null) : null,
    );
    this.state.set({ slots: next, selected });
  }

  /** Puts a semantic in one slot and chooses that slot (a drag onto the hotbar). */
  assign(slot: number, info: SemanticInfo): void {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return;
    const next = [...this.state.get().slots];
    next[slot] = info;
    this.state.set({ slots: next, selected: slot });
  }

  /**
   * Picks a semantic, as Minecraft's pick block does: chooses its slot if the hotbar has it,
   * else puts it in the chosen slot.
   */
  pick(info: SemanticInfo): void {
    const { slots, selected } = this.state.get();
    const at = slots.findIndex((s) => s !== null && sameSemantic(s, info));
    if (at >= 0) {
      this.select(at);
      return;
    }
    const next = [...slots];
    next[selected] = info;
    this.state.set({ slots: next, selected });
  }
}
