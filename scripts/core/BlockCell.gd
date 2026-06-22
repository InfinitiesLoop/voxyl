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
@export var type_id: String = ""
@export var orientation: int = 0
@export var tags: Dictionary = {}

func _init(p_type_id: String = "", p_orientation: int = 0, p_tags: Dictionary = {}) -> void:
	type_id = p_type_id
	orientation = p_orientation
	tags = p_tags

func duplicate_cell() -> BlockCell:
	return BlockCell.new(type_id, orientation, tags.duplicate(true))
