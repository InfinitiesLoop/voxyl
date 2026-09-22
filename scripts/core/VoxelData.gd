class_name VoxelData
extends Resource

# Sparse storage: only occupied cells are stored.
# Key: Vector3i position, Value: BlockCell (semantic id + orientation + tags).
# Coordinates are unbounded — negative values are valid.
#
# The value is always a BlockCell, never a bare color/material — the data layer
# stores intent. get_block() returns just the semantic id for the many callers
# that only care about "what kind of block is here"; get_cell() exposes the rest.
var cells: Dictionary = {}

# Cached get_used_aabb() result, invalidated on any mutation below. Recomputing the
# bounds is an O(cell count) scan; without this cache a caller that queries it once per
# visible cell in a redraw loop (View2DGrid) turns one redraw into O(visible × total)
# work, which is fine at a few hundred blocks and ruinous at tens of thousands. Every
# mutator lives in this file, so setting the flag here is the only place it's needed.
var _aabb_cache: Array = []
var _aabb_dirty := true

# --- Persisted mirror of `cells` --------------------------------------------
# `cells` is the runtime structure (a live Dictionary of BlockCell objects). For
# on-disk storage we don't embed one BlockCell sub-resource per voxel — a big build
# would explode into thousands of inline SubResources. Instead pack() flattens the
# grid into parallel Packed arrays (compact + fast to (de)serialize), and unpack()
# rebuilds `cells` from them. These @export fields are the ONLY thing ProjectStore
# writes; they carry the same intent (semantic ids + orientation), never materials.
@export var _packed_positions: PackedInt32Array = PackedInt32Array()  # x,y,z triples
@export var _packed_type_ids: PackedStringArray = PackedStringArray()
@export var _packed_orientations: PackedInt32Array = PackedInt32Array()
# Sparse tag side-channel: most cells carry no tags, so we only store the ones that
# do — the cell's index into the arrays above, paired with its tags dictionary.
@export var _packed_tag_indices: PackedInt32Array = PackedInt32Array()
@export var _packed_tags: Array = []
# Sparse shaped-part side-channel, same idea as tags: only part cells appear, as the cell's
# index paired with its parts flattened to [semantic, shape, slot] triples. A project saved
# before parts existed simply has none. The cell's _packed_type_ids entry is its primary
# (first part's) semantic, so old readers still see an occupied cell.
@export var _packed_part_indices: PackedInt32Array = PackedInt32Array()
@export var _packed_parts: Array = []

# Flatten `cells` into the @export packed mirror. Called by ProjectStore just before
# saving so the written resource reflects the current grid.
func pack() -> void:
	_packed_positions = PackedInt32Array()
	_packed_type_ids = PackedStringArray()
	_packed_orientations = PackedInt32Array()
	_packed_tag_indices = PackedInt32Array()
	_packed_tags = []
	_packed_part_indices = PackedInt32Array()
	_packed_parts = []
	var i := 0
	for pos: Vector3i in cells:
		var cell: BlockCell = cells[pos]
		_packed_positions.append(pos.x)
		_packed_positions.append(pos.y)
		_packed_positions.append(pos.z)
		_packed_type_ids.append(cell.type_id)
		_packed_orientations.append(cell.orientation)
		if not cell.tags.is_empty():
			_packed_tag_indices.append(i)
			_packed_tags.append(cell.tags.duplicate(true))
		if cell.is_shaped():
			_packed_part_indices.append(i)
			_packed_parts.append(pack_parts(cell.parts))
		i += 1

# Rebuild `cells` from the packed mirror. Called by ProjectStore after loading.
func unpack() -> void:
	cells = {}
	var tags_by_index := {}
	for j in _packed_tag_indices.size():
		tags_by_index[_packed_tag_indices[j]] = _packed_tags[j]
	var parts_by_index := {}
	for j in _packed_part_indices.size():
		parts_by_index[_packed_part_indices[j]] = _packed_parts[j]
	var count := _packed_type_ids.size()
	for i in count:
		var pos := Vector3i(
			_packed_positions[i * 3], _packed_positions[i * 3 + 1], _packed_positions[i * 3 + 2])
		var orientation := _packed_orientations[i] if i < _packed_orientations.size() else 0
		var tags: Dictionary = tags_by_index.get(i, {})
		var parts := unpack_parts(parts_by_index.get(i, []))
		cells[pos] = BlockCell.new(_packed_type_ids[i], orientation, tags, parts)
	_aabb_dirty = true

# Parts ⇄ plain [semantic, shape, slot] triples (compact on disk and in undo history).
static func pack_parts(parts: Array) -> Array:
	var out: Array = []
	for p in parts:
		out.append([str(p.get("semantic", "")), str(p.get("shape", "")), int(p.get("slot", 0))])
	return out

static func unpack_parts(packed: Array) -> Array:
	var out: Array = []
	for t in packed:
		out.append(BlockCell.make_part(str(t[0]), str(t[1]), int(t[2])))
	return out

# Add one shaped part to the cell at pos, creating a part cell if it's empty. Replaces a
# plain block if one is there — validity (ShapeRules) is the caller's job (VoxelWorld).
func add_part(pos: Vector3i, part: Dictionary) -> void:
	var cell: BlockCell = cells.get(pos, null)
	if cell == null or not cell.is_shaped():
		cell = BlockCell.new()
		cells[pos] = cell
	cell.parts.append(part.duplicate(true))
	cell.sync_type_id()
	_aabb_dirty = true

# Remove the part at `index`; the cell is erased once its last part goes.
func remove_part(pos: Vector3i, index: int) -> void:
	var cell: BlockCell = cells.get(pos, null)
	if cell == null or index < 0 or index >= cell.parts.size():
		return
	cell.parts.remove_at(index)
	if cell.parts.is_empty():
		cells.erase(pos)
	else:
		cell.sync_type_id()
	_aabb_dirty = true

# Set (or update) the block at pos. An empty type_id erases. Orientation/tags
# default to "plain" unless supplied — callers that care pass them explicitly.
func set_block(pos: Vector3i, type_id: String, orientation: int = 0, tags: Dictionary = {}) -> void:
	if type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = BlockCell.new(type_id, orientation, tags)
	_aabb_dirty = true

# Replace the whole cell object (used when moving/duplicating cells verbatim).
func set_cell(pos: Vector3i, cell: BlockCell) -> void:
	if cell == null or cell.type_id.is_empty():
		cells.erase(pos)
	else:
		cells[pos] = cell
	_aabb_dirty = true

func get_block(pos: Vector3i) -> String:
	var c: BlockCell = cells.get(pos, null)
	return c.type_id if c else ""

func get_cell(pos: Vector3i) -> BlockCell:
	return cells.get(pos, null)

func get_orientation(pos: Vector3i) -> int:
	var c: BlockCell = cells.get(pos, null)
	return c.orientation if c else 0

func clear_block(pos: Vector3i) -> void:
	cells.erase(pos)
	_aabb_dirty = true

# Returns [min: Vector3i, max: Vector3i] of all occupied cells, or [] if empty. Cached
# (see _aabb_dirty) since some callers (e.g. View2DGrid's per-visible-cell redraw loop)
# call this many times between edits — without the cache that turns one redraw into
# O(visible cells × total cells) instead of O(total cells) once.
func get_used_aabb() -> Array:
	if _aabb_dirty:
		_aabb_cache = _compute_used_aabb()
		_aabb_dirty = false
	return _aabb_cache

func _compute_used_aabb() -> Array:
	if cells.is_empty():
		return []
	var mn := Vector3i(cells.keys()[0])
	var mx := mn
	for pos: Vector3i in cells:
		mn.x = mini(mn.x, pos.x); mn.y = mini(mn.y, pos.y); mn.z = mini(mn.z, pos.z)
		mx.x = maxi(mx.x, pos.x); mx.y = maxi(mx.y, pos.y); mx.z = maxi(mx.z, pos.z)
	return [mn, mx]
