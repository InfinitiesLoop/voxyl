class_name Prefab
extends Resource

# A named, reusable piece of a build (a pillar, a bay module, a tree), global to the
# workspace like a palette. It stores cells exactly as a project does — semantic names,
# orientation, parts {semantic, shape, slot} — keyed relative to its own min corner, so the
# paste / rotate / mirror code is shared with the clipboard. It never stores a block or a
# color (Principle 1): placed into a project, its semantics resolve through that project's
# palette stack like any other cell.
#
# `palette_names` is only a preference: the stack its thumbnail and previews resolve through
# with no project open, and the palettes offered when a project placing it doesn't map some
# of its semantics. A placed prefab is plain cells; nothing links it back here.

@export var name: String = ""
# Auto-incremented at creation (VoxelWorkspace.add_prefab); higher = newer.
@export var id: int = 0
@export var created_at: int = 0
@export var modified_at: int = 0
@export var tags: Array[String] = []
@export var notes: String = ""
@export var data: VoxelData
# The box the cells were saved from (cells sit in [0, size)); empty space is part of it.
@export var size: Vector3i = Vector3i.ONE
# The handle cell, relative to the min corner: it lands on the aimed cell when placing, and
# a turn pivots about it. Default the min corner; bottom-center suits trees and pillars.
@export var anchor: Vector3i = Vector3i.ZERO
@export var palette_names: Array[String] = []

func _init() -> void:
	data = VoxelData.new()

func cell_count() -> int:
	return data.cells.size() if data else 0

# Semantic name → placed count (cells for whole blocks, parts for shaped cells).
func semantic_counts() -> Dictionary:
	var counts := {}
	for cell: BlockCell in data.cells.values():
		if cell.is_shaped():
			for p in cell.parts:
				var s := str(p["semantic"])
				counts[s] = counts.get(s, 0) + 1
		else:
			counts[cell.type_id] = counts.get(cell.type_id, 0) + 1
	return counts

func used_semantics() -> Array[String]:
	var out: Array[String] = []
	out.assign(semantic_counts().keys())
	out.sort()
	return out

# Bottom-center of the box: the natural handle for a tree or a pillar.
func bottom_center() -> Vector3i:
	return Vector3i(floori((size.x - 1) / 2.0), 0, floori((size.z - 1) / 2.0))

# Search haystack: name, tags and notes.
func matches(terms: PackedStringArray) -> bool:
	var hay := ("%s %s %s" % [name, " ".join(tags), notes]).to_lower()
	for t in terms:
		if not hay.contains(t.to_lower()):
			return false
	return true
