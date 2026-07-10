class_name Orientation
extends RefCounted

# Encodes how a block is placed, MC-style: a 6-way facing plus a "top half" flag
# (upside-down stairs/slabs). Stored as a single int on BlockCell.orientation so
# it travels with the cell and stays view-agnostic — no view owns it.
#
# Encoding: bits 0..2 = facing (0..5), bit 3 = top half.
# Default (0) = facing NORTH, bottom half — the resting orientation of a plain
# full block, for which orientation is simply ignored downstream.
#
# This is deliberately a thin, MC-shaped scheme rather than a full rotation:
# when we eventually export to Schematica/NBT we want a near-direct mapping.

enum Facing { NORTH, EAST, SOUTH, WEST, UP, DOWN }

const _TOP_BIT := 8

# World-space direction each facing points toward. North is -Z to match the 3D
# view's convention (camera looks down +Z at yaw 0 is handled separately).
const DIRS := {
	Facing.NORTH: Vector3i(0, 0, -1),
	Facing.EAST:  Vector3i(1, 0, 0),
	Facing.SOUTH: Vector3i(0, 0, 1),
	Facing.WEST:  Vector3i(-1, 0, 0),
	Facing.UP:    Vector3i(0, 1, 0),
	Facing.DOWN:  Vector3i(0, -1, 0),
}

const NAMES := ["North", "East", "South", "West", "Up", "Down"]

# Clockwise (viewed from above) cycle of the four horizontal facings.
const _CW := [Facing.NORTH, Facing.EAST, Facing.SOUTH, Facing.WEST]

# The four facings you pass through rotating 90° at a time around a given world axis
# (0=X, 1=Y, 2=Z) — i.e. the facings perpendicular to that axis, in cycle order. The
# axis's own two poles (e.g. UP/DOWN for the Y axis) have no image under that
# rotation, so they aren't members of any cycle; rotate_around_axis() special-cases
# starting from one. Axis 1 is the familiar horizontal ring (rotate_cw); axes 0 and 2
# are its counterparts for a block viewed from the side, and are how a 6-way block
# (barrel, dispenser, log, …) reaches an UP/DOWN facing.
const _AXIS_CYCLES := {
	0: [Facing.NORTH, Facing.UP, Facing.SOUTH, Facing.DOWN],
	1: _CW,
	2: [Facing.WEST, Facing.UP, Facing.EAST, Facing.DOWN],
}

static func make(facing: int, top: bool = false) -> int:
	return (facing & 7) | (_TOP_BIT if top else 0)

static func facing_of(o: int) -> int:
	return o & 7

static func is_top(o: int) -> bool:
	return (o & _TOP_BIT) != 0

static func with_facing(o: int, facing: int) -> int:
	return make(facing, is_top(o))

static func with_top(o: int, top: bool) -> int:
	return make(facing_of(o), top)

static func toggle_top(o: int) -> int:
	return make(facing_of(o), not is_top(o))

static func dir_of(o: int) -> Vector3i:
	return DIRS[facing_of(o)]

static func is_horizontal(facing: int) -> bool:
	return facing <= Facing.WEST

# Nearest 6-way facing for an arbitrary direction (used to derive facing from a
# clicked face normal or the camera look vector).
static func from_dir(v: Vector3) -> int:
	var ax := absf(v.x); var ay := absf(v.y); var az := absf(v.z)
	if ay >= ax and ay >= az:
		return Facing.UP if v.y >= 0.0 else Facing.DOWN
	if ax >= az:
		return Facing.EAST if v.x >= 0.0 else Facing.WEST
	return Facing.SOUTH if v.z >= 0.0 else Facing.NORTH

static func from_normal(n: Vector3i) -> int:
	return from_dir(Vector3(n))

# Rotate the horizontal facing by `steps` quarter-turns clockwise (from above).
# Vertical facings (Up/Down) collapse to North first so rotation always lands on
# a horizontal facing the user can keep cycling.
static func rotate_cw(o: int, steps: int = 1) -> int:
	return rotate_around_axis(o, 1, steps)

# Rotate a facing by `steps` quarter-turns around a world axis (0=X, 1=Y, 2=Z) — the
# general form of rotate_cw, which is just this fixed to the vertical (Y) axis. Used
# for blocks oriented across all 6 directions (barrels, dispensers, logs, …): looking
# at a block from the side and rotating around the axis you're facing is how such a
# block reaches an UP/DOWN facing, the same way rotate_cw cycles the 4 horizontal
# ones. A facing lying on the rotation axis itself (no image under that rotation)
# collapses to the cycle's start, so rotating always lands on a facing perpendicular
# to the axis instead of doing nothing.
static func rotate_around_axis(o: int, axis: int, steps: int = 1) -> int:
	var cycle: Array = _AXIS_CYCLES[axis]
	var f := facing_of(o)
	var idx: int = cycle.find(f)
	if idx < 0:
		idx = 0
	idx = (idx + steps) % 4
	if idx < 0:
		idx += 4
	return make(cycle[idx], is_top(o))

# Dominant world axis (0=X, 1=Y, 2=Z) of a direction vector — e.g. a clicked face's
# normal — used to decide which axis a rotate/placement should act around. Ties
# favor Y, then X, matching from_dir()'s own tie-breaking.
static func dominant_axis(v: Vector3i) -> int:
	var ax := absi(v.x); var ay := absi(v.y); var az := absi(v.z)
	if ay >= ax and ay >= az:
		return 1
	if ax >= az:
		return 0
	return 2

# Rotate a facing 90°*steps around the vertical (Y) axis as a RIGID transform of a whole
# structure it's part of — unlike rotate_cw (which deliberately collapses Up/Down to North so
# the interactive single-block R-key always lands on a horizontal facing), a block already
# facing Up/Down must keep that facing when the structure it belongs to swings around Y; only
# its position (see rotate_offset_cw) moves. Used by paste's rotate.
static func rotate_rigid_cw(o: int, steps: int = 1) -> int:
	var f := facing_of(o)
	if f == Facing.UP or f == Facing.DOWN:
		return o
	var idx: int = _CW.find(f)
	idx = ((idx + steps) % 4 + 4) % 4
	return make(_CW[idx], is_top(o))

# Rotate a relative position offset 90°*steps clockwise (viewed from above) around the Y axis
# through the origin — the same rotational sense as the facing cycle above (NORTH->EAST->
# SOUTH->WEST maps to (x,z) -> (-z,x) per step). Used to swing a copied region's cell positions
# around its pivot corner when a paste is rotated.
static func rotate_offset_cw(v: Vector3i, steps: int = 1) -> Vector3i:
	steps = ((steps % 4) + 4) % 4
	var x := v.x
	var z := v.z
	for i in steps:
		var nx := -z
		var nz := x
		x = nx
		z = nz
	return Vector3i(x, v.y, z)

static func name_of(o: int) -> String:
	var s: String = NAMES[facing_of(o)]
	if is_top(o):
		s += " (top)"
	return s

# 3D mesh transform for a cell. Source meshes are authored facing NORTH (-Z),
# bottom half; this rotates them into place. The top-half flip is a 180° turn
# about the (post-rotation) facing axis, which preserves facing while swapping
# top/bottom — exactly the upside-down-stairs transform.
static func basis_of(o: int) -> Basis:
	var f := facing_of(o)
	var b := Basis()
	match f:
		Facing.NORTH: b = Basis(Vector3.UP, 0.0)
		Facing.EAST:  b = Basis(Vector3.UP, -PI / 2.0)
		Facing.SOUTH: b = Basis(Vector3.UP, PI)
		Facing.WEST:  b = Basis(Vector3.UP, PI / 2.0)
		Facing.UP:    b = Basis(Vector3.RIGHT, -PI / 2.0)
		Facing.DOWN:  b = Basis(Vector3.RIGHT, PI / 2.0)
	if is_top(o):
		var axis := Vector3(DIRS[f])
		if axis.length() > 0.0:
			b = Basis(axis.normalized(), PI) * b
	return b
