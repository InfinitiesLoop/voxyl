class_name BlockCell
extends Resource

# One occupied voxel's intent. Like the data layer as a whole, this stores
# *intent*, never materials:
#   type_id     — the semantic block id ("Base", "Trim", …); the palette maps it
#                 to a concrete block + visual. Never a color or material name.
#   orientation — how the block was placed (facing + half). Encoded via the
#                 Orientation helper. This is MC-style block-state, not baked-in
#                 per-block knowledge: it's just one more piece of placement data.
#   tags        — open-ended NBT-style data ("note text", "redstone power", …).
#                 Most blocks have none; kept empty until something writes to it.
#   parts       — shaped parts sharing this cell (covers, strips, corners, …), each a
#                 { semantic: String, shape: String, slot: int } dictionary (see
#                 ShapeCatalog for what shape/slot mean). Empty for a plain block. A cell
#                 is EITHER one plain block OR a list of parts — never both. For a part
#                 cell, type_id mirrors parts[0].semantic (sync_type_id) so every "what's
#                 here / is it occupied" caller keeps working unchanged.
#                 The shape is stored per part on purpose: a palette edit can re-skin a
#                 part but never change its geometry (.plans/shaped-parts.md, decision 3).
@export var type_id: String = ""
@export var orientation: int = 0
@export var tags: Dictionary = {}
@export var parts: Array = []

func _init(p_type_id: String = "", p_orientation: int = 0, p_tags: Dictionary = {}, p_parts: Array = []) -> void:
	type_id = p_type_id
	orientation = p_orientation
	tags = p_tags
	parts = p_parts
	sync_type_id()

func is_shaped() -> bool:
	return not parts.is_empty()

# Keep type_id pointing at the first part's semantic for a part cell.
func sync_type_id() -> void:
	if not parts.is_empty():
		type_id = str(parts[0].get("semantic", ""))

func duplicate_cell() -> BlockCell:
	return BlockCell.new(type_id, orientation, tags.duplicate(true), parts.duplicate(true))

# A fresh part dictionary — the one place its keys are spelled.
static func make_part(semantic: String, shape: String, slot: int) -> Dictionary:
	return {"semantic": semantic, "shape": shape, "slot": slot}
