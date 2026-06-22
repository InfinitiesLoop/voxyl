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
	var f := facing_of(o)
	var idx := _CW.find(f)
	if idx < 0:
		idx = 0
	idx = (idx + steps) % 4
	if idx < 0:
		idx += 4
	return make(_CW[idx], is_top(o))

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
