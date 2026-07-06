class_name EditHistory
extends RefCounted

# The per-project undo/redo history: two stacks of EditOperation steps and the plumbing to
# move between them. Owned by VoxelProject (like its layout/hotbar) and persisted with it,
# so undo survives across sessions. VoxelWorld is the only thing that pushes/pops — views
# never touch this directly (Principle 2: one source of truth, views are lenses).
#
# This class knows nothing about the voxel data itself: it just stores/orders the deltas.
# Applying a step to the actual cells is VoxelWorld's job.

# How many steps back you can undo. Older steps fall off the bottom (a ring buffer), same
# as the history-state limit in an image editor. Generous default; cheap to raise since
# each step stores only its own delta.
const LIMIT := 100

# Newest is last. _undo is the redo-able-backwards past; _redo is the future you undid into.
var _undo: Array = []   # Array[EditOperation]
var _redo: Array = []   # Array[EditOperation]

# Push a freshly-sealed step. A new edit always invalidates the redo branch (you can't
# redo into a future you diverged from), then the oldest steps are trimmed to LIMIT.
func push(op: EditOperation) -> void:
	_undo.append(op)
	_redo.clear()
	while _undo.size() > LIMIT:
		_undo.pop_front()

# Move the newest undo step onto the redo stack and return it (for VoxelWorld to apply its
# `before` states). null when there's nothing to undo.
func pop_undo() -> EditOperation:
	if _undo.is_empty():
		return null
	var op: EditOperation = _undo.pop_back()
	_redo.append(op)
	return op

# Inverse of pop_undo: move the newest redo step back onto the undo stack and return it
# (for VoxelWorld to apply its `after` states). null when there's nothing to redo.
func pop_redo() -> EditOperation:
	if _redo.is_empty():
		return null
	var op: EditOperation = _redo.pop_back()
	_undo.append(op)
	return op

func can_undo() -> bool:
	return not _undo.is_empty()

func can_redo() -> bool:
	return not _redo.is_empty()

func clear() -> void:
	_undo.clear()
	_redo.clear()

# A flat description of the whole timeline for a Photoshop-style history view: past steps
# oldest→newest, then the undone (redo-able) steps, with `current` marking the index of the
# state you're currently at (-1 = the empty base state, before any recorded step). Each
# entry is {name, change_count, undone}. Purely a read model; the panel never mutates here.
func entries() -> Dictionary:
	var list: Array = []
	for op: EditOperation in _undo:
		list.append({"name": op.name, "change_count": op.change_count(), "undone": false})
	# _redo is stored newest-first (last popped is next to redo); present it in timeline
	# order (the step right after `current` first) by walking it in reverse.
	for i in range(_redo.size() - 1, -1, -1):
		var op: EditOperation = _redo[i]
		list.append({"name": op.name, "change_count": op.change_count(), "undone": true})
	return {"entries": list, "current": _undo.size() - 1}

# ---------------------------------------------------------------------------
# Serialization — plain nested data (Packed arrays inside dictionaries), round-tripped by
# VoxelProject/ProjectStore. No BlockCell or EditOperation resources are ever written.
# ---------------------------------------------------------------------------

func to_data() -> Dictionary:
	var undo_data: Array = []
	for op: EditOperation in _undo:
		undo_data.append(op.to_data())
	var redo_data: Array = []
	for op: EditOperation in _redo:
		redo_data.append(op.to_data())
	return {"undo": undo_data, "redo": redo_data}

static func from_data(d: Dictionary) -> EditHistory:
	var h := EditHistory.new()
	for od in d.get("undo", []):
		if od is Dictionary:
			h._undo.append(EditOperation.from_data(od))
	for od in d.get("redo", []):
		if od is Dictionary:
			h._redo.append(EditOperation.from_data(od))
	return h
