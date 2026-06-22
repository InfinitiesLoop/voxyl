class_name PaletteEntry
extends Resource

# A semantic slot in a palette.
# semantic_name is the key layouts use (e.g. "Base", "Accent 1", "Trim").
# block_type_name is the concrete block it maps to (e.g. "Stone", "Spruce Log").
# Visual color comes from BlockType.color, not stored here.
@export var semantic_name: String = ""
@export var block_type_name: String = ""
