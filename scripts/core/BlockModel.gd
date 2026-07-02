class_name BlockModel
extends Resource

# Neutral, voxel-agnostic geometry — generalizes the old BlockType.Shape enum.
# FULL / SLAB / STAIRS are no longer special-cased in the view; they are just the
# three built-in models below. Importers (or hand authoring) add more.
#
# Coordinates are in voxyl units: a full block spans (0,0,0)..(1,1,1),
# corner-origin, +Y up. (Minecraft's 0..16 ÷ 16 on import — but nothing here is
# MC-specific.) NORTH is -Z, matching Orientation's convention.
#
# An `elements` entry is a Dictionary:
#   { from: Vector3, to: Vector3, faces: Dictionary }
# `faces` maps a Dir (0..5) to a face Dictionary:
#   { texture_key: String, uv: Rect2, cullface: int, rotation: int, tint_index: int }
# Elements and faces are intrinsic to the model (never shared), so they stay plain
# dicts rather than separate resources. Textures ARE shared, so `textures` holds
# TextureAsset *ids* (decision 5), resolved through the workspace library.

# Box-face directions. Same order/convention as Orientation.Facing (NORTH=-Z …),
# but kept local so the model layer doesn't depend on the data layer's helper.
enum Dir { NORTH, EAST, SOUTH, WEST, UP, DOWN }

const ALL_DIRS := [Dir.NORTH, Dir.EAST, Dir.SOUTH, Dir.WEST, Dir.UP, Dir.DOWN]

# Reserved ids for the three built-in shapes (neutral, no namespace).
const BUILTIN_FULL := "full"
const BUILTIN_SLAB := "slab"
const BUILTIN_STAIRS := "stairs"

@export var id: String = ""
@export var elements: Array = []             # Array[Dictionary] — see above
@export var textures: Dictionary = {}        # texture_key:String -> TextureAsset id:String
@export var ambient_occlusion: bool = true

# True when the model binds any texture keys. The built-ins (full/slab/stairs)
# carry none, so they stay on the color path; an importer/hand-authored model with
# bindings opts into the textured render path. A quick gate before the (costlier)
# resolution of each key to an actual loadable image.
func has_textures() -> bool:
	return not textures.is_empty()

# The tallest element's top (max `to.y` across all elements), 0.0 if there are none.
# A pure geometry query — no MC/semantic knowledge — used by callers that classify a
# block's silhouette (e.g. "does this neighbor read as full-height or short") without
# hardcoding a single-element assumption (a model can have several boxes, and the
# tallest one determines the overall profile).
func max_height() -> float:
	var h := 0.0
	for el in elements:
		h = maxf(h, (el.get("to", Vector3.ZERO) as Vector3).y)
	return h

# --- Construction helpers ---------------------------------------------------

# A face bound to `texture_key`, full-face UVs by default. cullface/rotation/
# tint_index default to "none/identity"; the importer fills them from MC data.
static func make_face(texture_key: String, uv := Rect2(0, 0, 1, 1)) -> Dictionary:
	return {"texture_key": texture_key, "uv": uv, "cullface": -1, "rotation": 0, "tint_index": -1}

# One cuboid element spanning from..to, with all six faces bound to `texture_key`.
static func box_element(from: Vector3, to: Vector3, texture_key := "all") -> Dictionary:
	var faces := {}
	for d in ALL_DIRS:
		faces[d] = make_face(texture_key)
	return {"from": from, "to": to, "faces": faces}

# --- Built-in shapes --------------------------------------------------------

static func builtin_full() -> BlockModel:
	var m := BlockModel.new()
	m.id = BUILTIN_FULL
	m.elements = [box_element(Vector3.ZERO, Vector3.ONE)]
	return m

static func builtin_slab() -> BlockModel:
	var m := BlockModel.new()
	m.id = BUILTIN_SLAB
	m.elements = [box_element(Vector3.ZERO, Vector3(1, 0.5, 1))]
	return m

static func builtin_stairs() -> BlockModel:
	var m := BlockModel.new()
	m.id = BUILTIN_STAIRS
	# Bottom slab + upper step at the back (+Z), since NORTH (the facing) is -Z.
	m.elements = [
		box_element(Vector3.ZERO, Vector3(1, 0.5, 1)),
		box_element(Vector3(0, 0.5, 0.5), Vector3.ONE),
	]
	return m

static func builtin_models() -> Array[BlockModel]:
	return [builtin_full(), builtin_slab(), builtin_stairs()]

# Fresh built-in for a reserved id, or null. Used as a resolver safety net when a
# model library hasn't been seeded with the built-ins.
static func builtin_by_id(model_id: String) -> BlockModel:
	match model_id:
		BUILTIN_SLAB: return builtin_slab()
		BUILTIN_STAIRS: return builtin_stairs()
		BUILTIN_FULL: return builtin_full()
	return null
