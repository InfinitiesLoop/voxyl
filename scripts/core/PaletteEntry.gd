class_name PaletteEntry
extends Resource

# A semantic slot in a palette. Two kinds:
#   block entry  — semantic_name → block_type_name (e.g. "Base" → "Stone"). The concrete
#                  block it maps to; "" leaves it undecided.
#   shaped entry — semantic_name → a shape (ShapeCatalog id, e.g. "edge1" = Strip) cut from
#                  another entry's material (base_name, e.g. "Trim"). A shaped entry never
#                  names a block type itself: its look always flows from its base, resolved
#                  by name through the project's palette stack like any semantic. The base
#                  must be a block entry (no shaped → shaped chains).
# Visual color comes from BlockType.color, not stored here. See .plans/shaped-parts.md.
@export var semantic_name: String = ""
@export var block_type_name: String = ""
@export var shape_id: String = ""
@export var base_name: String = ""

func is_shaped() -> bool:
	return not shape_id.is_empty()
