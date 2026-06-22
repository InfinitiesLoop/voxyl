class_name BlockType
extends Resource

# A concrete, named block — "Stone", "Spruce Log", "Brick", etc.
# color is a planning hint; future versions will support textures here instead.
#
# shape is a *visual* property and lives here in the palette/material layer, never
# in the voxel data: the data only records that a cell is placed and how it's
# oriented. A given orientation is rendered as a cube, a slab, stairs, … purely
# based on the block type the palette currently maps the cell to. Swap the
# palette and the same data renders with entirely different shapes — the
# data/palette decoupling holds.
enum Shape { FULL, SLAB, STAIRS }

@export var name: String = ""
@export var color: Color = Color(0.5, 0.5, 0.5)
@export var shape: Shape = Shape.FULL
