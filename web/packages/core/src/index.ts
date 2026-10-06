export { type Box, boxOf, boxVolume, unionBox } from "./box.ts";
export {
  type CellState,
  type CellStateInput,
  CellStateTable,
  EMPTY_ID,
  MAX_STATES,
  type Part,
  semanticsOf,
  type TagValue,
} from "./cell-state.ts";
export { type BrickView, CellSet } from "./cellset.ts";
export { Chunk } from "./chunk.ts";
export {
  CellStateArg,
  type Command,
  type CommandContext,
  type CommandDef,
  CommandError,
  type Defined,
  defineCommand,
  defined,
  FormArg,
  IdArg,
  LookArg,
  NameArg,
  PartArg,
  SemanticArg,
} from "./commands/command.ts";
export { COMMANDS } from "./commands/index.ts";
export {
  ChunkLayout,
  chunkKey,
  chunkKeyToCoords,
  DEFAULT_CHUNK_BITS,
  MAX_CHUNK_BITS,
  MAX_CHUNK_COORD,
  MIN_CHUNK_BITS,
  MIN_CHUNK_COORD,
} from "./coords.ts";
export { decodeStorageChunk, encodeStorageChunk, STORAGE_SIZE } from "./format/chunk-codec.ts";
export { canonicalJSON, loadPrefab, prefabHash, savePrefab } from "./format/prefab.ts";
export {
  FORMAT_VERSION,
  loadProject,
  type Manifest,
  packBundle,
  type SavedProject,
  saveProject,
  unpackBundle,
} from "./format/project-file.ts";
export { type StateJSON, stateInput, stateJSON } from "./format/state-json.ts";
export {
  cutPiece,
  forEachPieceCell,
  importSemantics,
  type Piece,
  PieceArg,
  type PieceSemantic,
  pieceCellCount,
} from "./piece.ts";
export {
  type Click,
  type CompiledPlacement,
  compilePlacement,
  PICKS,
  type PickRule,
  PLACEMENTS,
  PlacementArg,
  type PlacementProfile,
  rotationOf,
  SIDE_VECTORS,
  SIDES,
  type Side,
  SideArg,
  SYMMETRIES,
  type SymmetryName,
  sideOf,
} from "./placement-profile.ts";
export {
  type Applied,
  type ChangeReport,
  type EntryState,
  type HistoryEntry,
  Project,
  type ProjectOptions,
  type RunResult,
  type SemanticChange,
  UNDO_LIMIT,
} from "./project.ts";
export { type RayHit, raycast } from "./raycast.ts";
export {
  BoxArg,
  DEFAULT_REACH,
  evaluate,
  MAX_REGION_CELLS,
  PosArg,
  plainBox,
  Region,
  RegionError,
  type RegionScope,
} from "./region.ts";
export {
  LegendValue,
  MAX_TEXT_CELLS,
  parseRegionText,
  type RegionText,
  RegionTextArg,
  RegionTextError,
  regionText,
  type TextAxis,
  textToWorld,
} from "./region-text.ts";
export {
  type Axis,
  canonical,
  compose,
  determinant,
  facingOf,
  fromMatrix,
  IDENTITY,
  inverse,
  isRotation,
  MODEL_FRONT,
  MODEL_UP,
  matrixOf,
  mirror,
  ROTATION_COUNT,
  type Rotation,
  rotate,
  rotationFacing,
  SYMMETRY,
  stabilizer,
  transformRotation,
  turn,
  turnClockwise,
  upOf,
  type Vec3,
} from "./rotation.ts";
export {
  type Form,
  type Look,
  NO_SEMANTIC,
  type Offer,
  type Palette,
  type PaletteId,
  type PalettePatch,
  type RegistryJSON,
  type ResolvedSemantic,
  ROOT_PALETTE,
  type Semantic,
  type SemanticId,
  type SemanticPatch,
  SemanticRegistry,
  type SharedPalette,
} from "./semantics.ts";
export {
  DEFAULT_SETTINGS,
  MAJOR_GRID,
  type ProjectSettings,
  SettingsArg,
  settingsFrom,
} from "./settings.ts";
export { type RegionStats, regionStats } from "./stats.ts";
export {
  applyMatrix,
  DIRECTIONS,
  type Direction,
  DirectionArg,
  type MirrorAxis,
  movedBox,
  PlacementArgs,
  placementMatrix,
  StateMover,
  turnsBetween,
} from "./transform.ts";
export { type ChangedBox, type Edit, World, type WorldOptions } from "./world.ts";
