class_name PaletteEntry
extends Resource

# The semantic type this entry provides a visual for.
@export var block_type_id: String = ""
# Concrete block name, e.g. "Oak Planks", "Stone". Optional — can be unnamed while planning.
@export var block_name: String = ""
@export var color: Color = Color.GRAY
