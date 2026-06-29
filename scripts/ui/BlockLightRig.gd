class_name BlockLightRig
extends RefCounted

# The one lighting setup for off-project block renders — the rotatable detail preview
# (BlockPreview3D) and the baked grid icons (BlockIconBaker). Both framed a unit cell
# with their own copy of an ambient + key/fill rig; sharing it here keeps a block's
# swatch and its preview identical, and makes lighting a one-place tweak.
#
# Tuned to read less washed-out than a heavy ambient fill: the key light does most of
# the work so faces are clearly shaded (top brightest, sides mid, bottom dark), and a
# modest neutral ambient only lifts the shadow side instead of flattening every face
# toward the same pale value. Background stays a transparent clear color.
#
# The key light is aimed from the camera's own side (raised and swung off-axis), so the
# faces the camera actually sees are the lit ones — not the hidden back. A fixed key
# opposite the camera left the camera-facing face (and a spinning block's near face) in
# shadow; keying over the camera's shoulder fixes that while the off-axis swing keeps
# the two visible side faces at different values so the block still reads as 3D.

const _AMBIENT_COLOR := Color(0.60, 0.62, 0.68)
const _AMBIENT_ENERGY := 0.32
const _KEY_ENERGY := 1.05
const _FILL_ENERGY := 0.28

# Add the WorldEnvironment + key/fill lights to `viewport`, with the key keyed to the
# camera direction `cam_dir` (the look vector the camera sits along). Call once at setup.
static func apply(viewport: SubViewport, cam_dir: Vector3) -> void:
	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_CLEAR_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = _AMBIENT_COLOR
	env.ambient_light_energy = _AMBIENT_ENERGY
	world_env.environment = env
	viewport.add_child(world_env)

	var dir := cam_dir.normalized()

	# Key from the camera's side: swing ~28° off the camera azimuth and lift it so the
	# top reads brightest and the two visible sides differ. look_at aims the light's -Z
	# (its travel direction) at the block, so position only fixes the direction.
	var key := DirectionalLight3D.new()
	key.light_energy = _KEY_ENERGY
	viewport.add_child(key)
	key.position = dir.rotated(Vector3.UP, deg_to_rad(-28)) + Vector3(0, 0.7, 0)
	key.look_at(Vector3.ZERO)

	# Fill from the opposite azimuth, kept low and near the horizon so it only lifts the
	# shadow side of the visible faces rather than flattening them.
	var fill := DirectionalLight3D.new()
	fill.light_energy = _FILL_ENERGY
	viewport.add_child(fill)
	fill.position = -dir.rotated(Vector3.UP, deg_to_rad(40)) + Vector3(0, 0.25, 0)
	fill.look_at(Vector3.ZERO)
