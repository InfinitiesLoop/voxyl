class_name SchematicaMeta
extends RefCounted

# The final Minecraft metadata value for a placed whole block: McId's confirmed base meta
# (mc.meta), adjusted for whichever orientation family (mc.orient) the block belongs to.
# Every bit layout below is public, unchanging Minecraft data (the same encoding for any
# 1.7-era slab/stairs/log block), never guessed — see McId.gd's doc comment for how
# mc.orient gets set (NeiRosterImporter never sets it to anything but "", since NEI's dumps
# don't expose which orientation family a block belongs to; block_set_mc_id is how a whole-
# block export of a slab/stairs/log-shaped semantic gets corrected). mc.orient "" (everything
# not yet manually corrected) just passes the confirmed meta through unchanged.

static func final_meta(bt: BlockType, orientation: int) -> int:
	var base := McId.get_mc_meta(bt)
	match McId.get_orient(bt):
		McId.ORIENT_HALF:
			return _half_meta(base, orientation)
		McId.ORIENT_STAIRS:
			return _stairs_meta(base, orientation)
		McId.ORIENT_LOG_AXIS:
			return _log_axis_meta(base, orientation)
		_:
			return base

# Slabs: bit 3 (8) is the top/bottom half; bits 0-2 are the confirmed (bottom-half) slab type.
static func _half_meta(base: int, orientation: int) -> int:
	return (base & 0x7) | (8 if Orientation.is_top(orientation) else 0)

# Stairs: bits 0-1 select which way the open (concave) side faces; bit 2 (4) flips it upside-
# down. MC's own facing-id order for stairs (0=East, 1=West, 2=South, 3=North) doesn't match
# Orientation.Facing's own order — confirmed against vanilla stairs' real blockstate values.
const _STAIRS_FACING := {
	Orientation.Facing.EAST: 0, Orientation.Facing.WEST: 1,
	Orientation.Facing.SOUTH: 2, Orientation.Facing.NORTH: 3,
}

static func _stairs_meta(_base: int, orientation: int) -> int:
	var facing: int = Orientation.facing_of(orientation)
	var mc_facing: int = _STAIRS_FACING.get(facing, 3)
	return mc_facing | (4 if Orientation.is_top(orientation) else 0)

# Logs (and log-shaped decorative blocks): bits 0-1 are the confirmed wood-type meta; bits
# 2-3 select the axis the log runs along — 0 = up-down (Y, the confirmed resting pose), 4 =
# east-west (X), 8 = north-south (Z). 12 ("bark on every side") has no Orientation facing to
# reach and is never produced here.
static func _log_axis_meta(base: int, orientation: int) -> int:
	var facing: int = Orientation.facing_of(orientation)
	var axis_bits := 0
	if facing == Orientation.Facing.EAST or facing == Orientation.Facing.WEST:
		axis_bits = 4
	elif facing == Orientation.Facing.NORTH or facing == Orientation.Facing.SOUTH:
		axis_bits = 8
	return (base & 0x3) | axis_bits
