export {
  type BlockMatch,
  type BlockQuery,
  blockIcon,
  blockLabel,
  searchBlocks,
} from "./catalog.ts";
export {
  type CompiledBlock,
  type CompiledFace,
  compileBlock,
  type Libraries,
} from "./compile.ts";
export { buildDefaultLibrary, DEFAULT_LIBRARY_ID, defaultLibrary } from "./defaults/library.ts";
export { DEFAULT_TEXTURE_KEYS, paintTexture, textureOf } from "./defaults/textures.ts";
export { bakeBlockIcon, ICON_RES } from "./icon.ts";
export {
  type Alpha,
  type Block,
  type Condition,
  type Element,
  type Face,
  type Library,
  MC_SIDES,
  type McSide,
  type Model,
  parseBlockRef,
  type Texture,
  type Variant,
} from "./library.ts";
export { profileOfBlock } from "./placement.ts";
export {
  type CompiledShape,
  compileShape,
  JOIN_FENCE,
  JOIN_PANE,
  JOIN_SIDES,
  JOIN_WALL,
  type ShapeFace,
} from "./shape.ts";
export { decodeLibrary, encodeLibrary, LIBRARY_FORMAT } from "./storage.ts";
export {
  type ElementTurn,
  elementTurn,
  FACE_SIDES,
  faceUvMap,
  SIDE_NORMAL,
  sideOfNormal,
} from "./uv.ts";
export {
  matches,
  type PlacedModel,
  parseProps,
  placeBlock,
  rotatePoint16,
  variantFor,
  variantRotation,
} from "./variants.ts";
