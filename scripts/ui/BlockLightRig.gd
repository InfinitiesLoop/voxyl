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

const _AMBIENT_COLOR := Color(0.60, 0.62, 0.68)
const _AMBIENT_ENERGY := 0.32
const _KEY_ENERGY := 1.05
const _FILL_ENERGY := 0.28

# Add the WorldEnvironment + key/fill lights to `viewport`. Call once at setup.
static func apply(viewport: SubViewport) -> void:
	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_CLEAR_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = _AMBIENT_COLOR
	env.ambient_light_energy = _AMBIENT_ENERGY
	world_env.environment = env
	viewport.add_child(world_env)

	var key := DirectionalLight3D.new()
	key.rotation_degrees = Vector3(-50, 45, 0)
	key.light_energy = _KEY_ENERGY
	viewport.add_child(key)

	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(40, -135, 0)
	fill.light_energy = _FILL_ENERGY
	viewport.add_child(fill)
