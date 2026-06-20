class_name PaletteEntry
extends Resource

# A semantic slot in a palette.
# semantic_name is the key layouts use (e.g. "Base", "Accent 1", "Trim").
# block_type_name is the concrete block it maps to (e.g. "Stone", "Spruce Log").
# color is a planning hint only — helps visually distinguish slots while building.
@export var semantic_name: String = ""
@export var block_type_name: String = ""
@export var color: Color = Color.GRAY
