export {
  ARCH_SHAPES,
  ARCH_SLOTS,
  type ArchShape,
  archRotation,
  archSlot,
  archTriangles,
} from "./arch.ts";
export { SHAPE_PAGES, type ShapePage, shapeName } from "./catalog.ts";
export { hitPart, type PartHit } from "./hit.ts";
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
  hitSlot,
  oppositeSlot,
  orientFromHit,
  orientOnPlacement,
  type PartPlacement,
  type PlacementWorld,
  placementGrid,
  resolvePlacement,
  SIDE_VECTORS,
  sideFromNormal,
  usesOpposite,
  type Vec3,
} from "./placement.ts";
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
