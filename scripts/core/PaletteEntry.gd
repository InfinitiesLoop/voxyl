class_name PaletteEntry
extends Resource

# A semantic slot in a palette: semantic_name → block_type_name (e.g. "Base" → "Stone"),
# the concrete block it maps to ("" leaves it undecided).
#
# An entry can also carry a shape (shape_id, a ShapeCatalog id — e.g. "edge1" = Strip):
# then it places that shape cut from its block type, instead of the whole block. Shape and
# block type are independent picks on the one entry; both are intent, neither is a
# material stored in the voxel data (placed parts store their own shape — see
# .plans/shaped-parts.md). Visual color comes from BlockType.color, not stored here.
@export var semantic_name: String = ""
@export var block_type_name: String = ""
@export var shape_id: String = ""
# Legacy: an early version cut shaped entries from another entry's block (a "base"). Only
# read on load, where Palette.migrate_legacy_shapes folds it into block_type_name and
# clears it. Kept so older saved palettes keep their look (and as a hook if chaining
# entries ever comes back).
@export var base_name: String = ""

func is_shaped() -> bool:
	return not shape_id.is_empty()
