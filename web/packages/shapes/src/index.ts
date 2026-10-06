export {
  ARCH_SHAPES,
  ARCH_SLOTS,
  type ArchShape,
  archRotation,
  archSlot,
  archTriangles,
} from "./arch.ts";
export {
  type Box8,
  CENTER_SLOT,
  edgeBetween,
  MICRO_SHAPES,
  type MicroFamily,
  type MicroShape,
  microBoxes,
  microSlotCount,
  sideOf,
} from "./micro.ts";
export { SIDE_NAMES, slotFromName, slotName, slotNames } from "./names.ts";
export {
  isExclusive,
  isValidSlot,
  type RejectReason,
  type RulePart,
  rejectCell,
  rejectPart,
  renderOrder,
} from "./rules.ts";
export { type CellMatrix, isKnownShape, slotsLookAlike, transformSlot } from "./transform.ts";
