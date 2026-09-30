class_name CompassRose
extends Control

# A minimal compass: a faint disc, a needle toward north with an "N", and dim E / S / W around
# it. A pure lens (Principle 2) — it owns no data; a view feeds it which way north currently
# points on screen. `heading` is the clockwise angle (radians) from screen-up to north; a view
# gets it from heading_for(). Set the project's north with VoxelWorld.set_project_settings.

const SIZE := 92.0
const _RING := 28.0
const _NEEDLE := Color(0.95, 0.42, 0.38)
const _INK := Color(0.86, 0.9, 0.96)
const _DIM := Color(0.62, 0.68, 0.76)

var heading := 0.0:
	set(value):
		if not is_equal_approx(value, heading):
			heading = value
			queue_redraw()
# A mirrored view (the 2D plan flipped left-right) reads the compass the other way round: E, S, W
# go counter-clockwise from N.
var mirrored := false:
	set(value):
		if value != mirrored:
			mirrored = value
			queue_redraw()

func _init() -> void:
	custom_minimum_size = Vector2(SIZE, SIZE)
	mouse_filter = Control.MOUSE_FILTER_IGNORE

# The clockwise angle from screen-up to north, for a camera whose ground-plane "forward" is
# `forward` (x, z) and a project whose north is `north` (x, z) — both on the ground, z southward
# (see VoxelProject.north_vector). Looking north it's 0 (north is up); looking east, north is to
# the left (-90°). A camera looking straight down has no forward on the ground, so the caller
# passes its screen-up direction instead (which is what "forward" means from above). `flipped`:
# the view is flipped left-right, so the turn goes the other way.
static func heading_for(forward: Vector2, north: Vector2, flipped := false) -> float:
	if forward.length_squared() < 1e-8:
		return 0.0
	var angle := forward.angle_to(north)
	return -angle if flipped else angle

func _draw() -> void:
	var c := Vector2(SIZE, SIZE) * 0.5
	draw_circle(c, _RING, Color(0.05, 0.07, 0.1, 0.42))
	draw_arc(c, _RING, 0.0, TAU, 48, Color(0.6, 0.7, 0.8, 0.55), 1.2, true)
	var north := Vector2.UP.rotated(heading)
	var east := north.rotated(-PI * 0.5 if mirrored else PI * 0.5)
	# Needle: a slim kite, bright toward north, faint toward south.
	var side := east * 5.0
	draw_colored_polygon(PackedVector2Array([c + north * (_RING - 3.0), c + side, c - side]), _NEEDLE)
	draw_colored_polygon(PackedVector2Array([c - north * (_RING - 8.0), c + side, c - side]), Color(0.75, 0.8, 0.88, 0.35))
	var font := ThemeDB.fallback_font
	_letter(font, "N", c + north * (_RING + 11.0), 18, _INK)
	_letter(font, "E", c + east * (_RING + 9.0), 13, _DIM)
	_letter(font, "S", c - north * (_RING + 9.0), 13, _DIM)
	_letter(font, "W", c - east * (_RING + 9.0), 13, _DIM)

# Draw `text` centered on `at`.
func _letter(font: Font, text: String, at: Vector2, font_size: int, color: Color) -> void:
	var ext := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size)
	draw_string(font, at + Vector2(-ext.x * 0.5, ext.y * 0.3), text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, color)
