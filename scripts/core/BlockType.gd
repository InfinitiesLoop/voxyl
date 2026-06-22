class_name BlockType
extends Resource

# A concrete, named block — "Stone", "Spruce Log", "Brick", etc.
# color is a planning hint; future versions will support textures here instead.
@export var name: String = ""
@export var color: Color = Color(0.5, 0.5, 0.5)
