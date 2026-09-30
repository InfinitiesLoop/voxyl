class_name Attachment
extends RefCounted

# How a block holds on to its neighbours: a torch stands on the block below or leans out from
# a wall, but never hangs off the block above; a painting would only go on walls; a lantern
# stands or hangs. Neutral vocabulary, nothing Minecraft-specific in how it is stored or asked
# about. The rules are data: a KIND says which facings are possible and which is the default,
# and a block type opts in by naming its kind (BlockType.attachment), or by having geometry
# that says so (detect). Adding a kind is one entry below + its model in AttachmentModels.
#
# What a cell stores is the ordinary Orientation facing, read as "the direction this block
# points, away from what holds it" (Minecraft's own `facing` for a wall torch): UP = standing
# on the block below, NORTH = held by the block on its south side and leaning north. That's
# the same number a barrel or dispenser uses for the face it was placed against, so the
# placement, rotation, paste and symmetry code that already turns facings needs no new cases.
# "Held by" is the opposite direction (support_dir). Nothing checks that the holding block is
# still there: an attached block may hang in the air (the data stays intent, not physics).

const NONE := ""
# An explicit "this block is NOT attachable", beating geometry detection (BlockType.attachment).
const OPT_OUT := "none"
const TORCH := "torch"

const _KINDS := {
	TORCH: {
		"label": "torch",
		"facings": [Orientation.Facing.UP, Orientation.Facing.NORTH, Orientation.Facing.EAST,
			Orientation.Facing.SOUTH, Orientation.Facing.WEST],   # not DOWN: can't hang off the block above
		"default": Orientation.Facing.UP,   # unspecified = standing on the floor
	},
}

static func kinds() -> Array:
	return _KINDS.keys()

static func is_kind(kind: String) -> bool:
	return _KINDS.has(kind)

static func label(kind: String) -> String:
	return str(_KINDS[kind]["label"]) if _KINDS.has(kind) else ""

static func facings(kind: String) -> Array:
	return (_KINDS[kind]["facings"] as Array).duplicate() if _KINDS.has(kind) else []

static func default_facing(kind: String) -> int:
	return int(_KINDS[kind]["default"]) if _KINDS.has(kind) else Orientation.Facing.NORTH

static func allows(kind: String, facing: int) -> bool:
	return _KINDS.has(kind) and (_KINDS[kind]["facings"] as Array).has(facing)

# The facing a click on a face gives: the face's outward normal, exactly as a barrel takes it
# (top of a block → UP/standing, a wall's side → leaning out of it). -1 when the kind can't
# take that one (a torch clicked on the underside of a block), meaning "don't place".
static func facing_for_click(kind: String, normal: Vector3i) -> int:
	var f := Orientation.from_normal(normal)
	return f if allows(kind, f) else -1

# The next allowed facing, `steps` along the kind's own order (the R key).
static func next_facing(kind: String, facing: int, steps := 1) -> int:
	var list := facings(kind)
	if list.is_empty():
		return facing
	var at := list.find(facing)
	if at < 0:
		return int(list[0])
	return int(list[posmod(at + steps, list.size())])

# Where the holding block is, relative to the attached one (opposite the facing).
static func support_dir(facing: int) -> Vector3i:
	return -Orientation.DIRS[facing]

# Facing for a block held by the neighbour in `support` (a unit direction).
static func facing_held_by(support: Vector3i) -> int:
	return Orientation.from_normal(-support)

# Lower-case side word of the holding block ("down", "north", …): what MCP callers say.
static func held_by_name(facing: int) -> String:
	return Orientation.NAMES[Orientation.from_normal(support_dir(facing))].to_lower()

static func refusal(kind: String, facing: int) -> String:
	if kind == TORCH and facing == Orientation.Facing.DOWN:
		return "a torch can't hang from the block above it; it stands on the block below or leans out of a wall"
	return "a %s can't face %s" % [label(kind), Orientation.NAMES[facing].to_lower()]

# The kind a block type declares (its explicit choice, or, unset, what its geometry says).
# "" for a block that isn't attachable.
static func kind_of(bt: BlockType, model: BlockModel) -> String:
	if bt == null:
		return NONE
	if bt.attachment == OPT_OUT:
		return NONE
	if is_kind(bt.attachment):
		return bt.attachment
	return detect(model)

# What a block model's geometry says it is. Today: the torch cap — the 2×10×2 post with only
# its top and bottom textured, which the standing torch model and the leaning wall torch both
# carry (modern Minecraft-format models; old flat-imported mod torches say nothing, so they
# are flagged explicitly). Cached per model revision: a rebuild asks for every cell.
static var _detected := {}

static func detect(model: BlockModel) -> String:
	if model == null:
		return NONE
	var key := model.get_instance_id()
	var hit: Dictionary = _detected.get(key, {})
	if hit.get("rev", -1) == model.revision:
		return str(hit["kind"])
	var kind := TORCH if _has_torch_cap(model) else NONE
	_detected[key] = {"rev": model.revision, "kind": kind}
	return kind

static func _has_torch_cap(model: BlockModel) -> bool:
	for el: Dictionary in model.elements:
		if el.has("mesh"):
			continue
		var size: Vector3 = (el["to"] as Vector3) - (el["from"] as Vector3)
		if absf(size.x - 0.125) > 0.01 or absf(size.y - 0.625) > 0.01 or absf(size.z - 0.125) > 0.01:
			continue
		var faces: Dictionary = el.get("faces", {})
		if faces.size() == 2 and faces.has(BlockModel.Dir.UP) and faces.has(BlockModel.Dir.DOWN):
			return true
	return false

# --- Rendering ------------------------------------------------------------------------

# The model to draw for a block of `kind` textured with `texture_id`, held in `facing`, and
# the turn about the vertical axis (degrees, in the importer's blockstate convention) to draw
# it with. A facing the kind can't take draws as its default so a stray cell is still seen.
static func render(kind: String, texture_id: String, facing: int) -> Dictionary:
	if not allows(kind, facing):
		facing = default_facing(kind)
	match kind:
		TORCH:
			return {"model": AttachmentModels.torch(texture_id, facing != Orientation.Facing.UP),
				"y_rot": _wall_turn(facing)}
	return {}

# Wall models are authored leaning toward +X (EAST); the turn that points them elsewhere —
# the same degrees Minecraft's own wall-torch blockstate uses.
static func _wall_turn(facing: int) -> int:
	match facing:
		Orientation.Facing.SOUTH: return 90
		Orientation.Facing.WEST: return 180
		Orientation.Facing.NORTH: return 270
	return 0
