class_name EditOperation
extends RefCounted

# One logical undo/redo step — a "history state" in image-editor terms. It records the
# MINIMAL delta needed to move the voxel data forward (redo) or back (undo): a set of
# per-cell {before, after} changes, never a snapshot of the whole build. A single block
# placement is an op with one change; a line/rect/fill/paste is one op with many. The
# rebuild loop, views, and persistence all treat every step the same way regardless of
# how many cells it touched.
#
# A "cell state" here is an encoded plain-data tuple, NOT a BlockCell object, so an op can
# be serialized without embedding one sub-resource per voxel (same reason VoxelData packs):
#   null                          — the cell was/became empty
#   [type_id: String, orientation: int, tags: Dictionary]  — an occupied cell
# type_id is never "" for an occupied cell (VoxelData erases on empty type), so "" in the
# packed form unambiguously means "no cell".

# Human-facing label for a history view ("Paint", "Erase", "Fill", …). Voxel-agnostic by
# design — no material/palette/Minecraft vocabulary leaks in here.
var name: String = ""

# Recording buffer (Vector3i -> {"before":encoded, "after":encoded}). Populated by
# record() while the owning transaction is open, then frozen into the parallel arrays
# below by seal(). Cleared after sealing so a sealed op carries no redundant state.
var _rec: Dictionary = {}

# Sealed, apply-ready parallel arrays (positions[i] changed from befores[i] to afters[i]).
# Only cells whose before != after survive sealing, so a stroke that painted over itself
# contributes nothing.
var positions: Array[Vector3i] = []
var befores: Array = []
var afters: Array = []
var _sealed := false

func _init(p_name: String = "") -> void:
	name = p_name

# Buffer a single cell's change. Called once per touched cell per mutation; if the same
# cell is touched again in this op (a drag revisiting a cell), the ORIGINAL before is kept
# and only after advances — so undo restores the pre-stroke state, not an intermediate one.
func record(pos: Vector3i, before: Variant, after: Variant) -> void:
	if _rec.has(pos):
		_rec[pos]["after"] = after
	else:
		_rec[pos] = {"before": before, "after": after}

# Freeze the recording buffer into the apply-ready arrays, dropping no-op cells
# (before == after — e.g. painting the block that was already there, or a cell nudged and
# returned within one stroke). Idempotent.
func seal() -> void:
	if _sealed:
		return
	_sealed = true
	for pos: Vector3i in _rec:
		var c: Dictionary = _rec[pos]
		if c["before"] != c["after"]:
			positions.append(pos)
			befores.append(c["before"])
			afters.append(c["after"])
	_rec.clear()

# True when the op made no net change and should not become a history entry.
func is_empty() -> bool:
	return positions.is_empty()

func change_count() -> int:
	return positions.size()

# ---------------------------------------------------------------------------
# Serialization — compact packed form, mirroring VoxelData.pack(). Positions and the
# before/after type+orientation columns go into Packed arrays; tags (almost always empty)
# ride a sparse side-channel keyed by change index. No BlockCell sub-resources are emitted.
# ---------------------------------------------------------------------------

func to_data() -> Dictionary:
	if not _sealed:
		seal()
	var pos := PackedInt32Array()
	var bt := PackedStringArray()   # before type ids ("" = no cell)
	var bo := PackedInt32Array()    # before orientations
	var at := PackedStringArray()   # after type ids ("" = no cell)
	var ao := PackedInt32Array()    # after orientations
	var tags := {}                  # "b<i>"/"a<i>" -> tags dict, only when non-empty
	for i in positions.size():
		var p: Vector3i = positions[i]
		pos.append(p.x); pos.append(p.y); pos.append(p.z)
		var b: Variant = befores[i]
		var a: Variant = afters[i]
		bt.append(b[0] if b != null else "")
		bo.append(b[1] if b != null else 0)
		at.append(a[0] if a != null else "")
		ao.append(a[1] if a != null else 0)
		if b != null and not (b[2] as Dictionary).is_empty():
			tags["b%d" % i] = b[2]
		if a != null and not (a[2] as Dictionary).is_empty():
			tags["a%d" % i] = a[2]
	return {"name": name, "pos": pos, "bt": bt, "bo": bo, "at": at, "ao": ao, "tags": tags}

static func from_data(d: Dictionary) -> EditOperation:
	var op := EditOperation.new(str(d.get("name", "")))
	op._sealed = true
	var pos: PackedInt32Array = d.get("pos", PackedInt32Array())
	var bt: PackedStringArray = d.get("bt", PackedStringArray())
	var bo: PackedInt32Array = d.get("bo", PackedInt32Array())
	var at: PackedStringArray = d.get("at", PackedStringArray())
	var ao: PackedInt32Array = d.get("ao", PackedInt32Array())
	var tags: Dictionary = d.get("tags", {})
	var count := bt.size()
	for i in count:
		op.positions.append(Vector3i(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]))
		op.befores.append(_decode(bt[i], bo[i], tags.get("b%d" % i, {})))
		op.afters.append(_decode(at[i], ao[i], tags.get("a%d" % i, {})))
	return op

# Rebuild an encoded cell tuple from its packed columns. "" type => null (no cell).
static func _decode(type_id: String, orientation: int, cell_tags: Dictionary) -> Variant:
	if type_id.is_empty():
		return null
	return [type_id, orientation, cell_tags]
