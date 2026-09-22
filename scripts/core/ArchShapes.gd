class_name ArchShapes
extends RefCounted

# Architecture shapes — roofs, slopes, stairs, cylinders, capitals, arches, railings, … —
# the "one shape per block, any of 24 orientations" half of the shape catalog (the other
# half is the microblock families in ShapeCatalog). Ported from ArchitectureCraft so a build
# planned here maps 1:1 onto the in-game mod later (.plans/shaped-parts.md), but nothing
# here needs the mod: it's geometry, orientation math and placement rules.
#
# Geometry comes from two places, exactly as in the mod:
#   "roof"            — generated here (ported from AC's RenderRoof): roof tiles, corners,
#                       ridges, valleys and the A/B/C slope tiles.
#   "model:<file>" /  — AC's own triangle meshes, vendored under MODEL_DIR (MIT — see the
#   "banister:<file>"   LICENSE there), loaded lazily and cached.
#
# Frames: a shape is authored block-centered (-0.5..0.5), base on -Y, at turn 0. A placed
# part's `slot` encodes its orientation the way the mod does — slot = side * 4 + turn, where
# `side` (ShapeCatalog side numbering, 0..5) is the face the shape's base sits on and `turn`
# is a quarter-turn about that face — plus, for OFFSET shapes (banisters), 24 more slots for
# the mirrored half-block shift: slot >= 24 → shifted toward local -X, else +X.

const MODEL_DIR := "res://assets/shapes/architecturecraft/"

# Symmetry decides how a click position picks the turn (AC's ShapeSymmetry).
const UNI := 0      # nearest corner
const BI := 1       # nearest edge
const QUAD := 2     # all turns look alike
const NONE := 3

# Flags (AC's ShapeFlags).
const UNDERNEATH := 1   # "right side up" is hanging from above (arches)
const OFFSET := 2       # shifts half a block toward the clicked side (banisters)

const _OFFSET_X := 6.0 / 16.0   # AC Banister.placementOffsetX

# id -> [name, geometry, symmetry, collision mask, profile set, flags]. Generated from AC's
# Shape table (ids are its enum names in snake_case). Collision masks are AC's
# occlusionMask: 0x0XX = 2x2x2 cubelet bitmap, 0x1XX = square post of radius XX/16, 0 = use
# the model's own boxes. Profiles are how shapes line up with a neighbor on placement.
const TABLE := {
	"roof_tile": ["Roof Tile", "roof", BI, 0xcf, "", 0],
	"roof_outer_corner": ["Roof Outer Corner", "roof", UNI, 0x4f, "", 0],
	"roof_inner_corner": ["Roof Inner Corner", "roof", UNI, 0xdf, "", 0],
	"roof_ridge": ["Gabled Roof Ridge", "roof", BI, 0x0f, "", 0],
	"roof_smart_ridge": ["Hip Roof Ridge", "roof", QUAD, 0x0f, "", 0],
	"roof_valley": ["Gabled Roof Valley", "roof", BI, 0xff, "", 0],
	"roof_smart_valley": ["Hip Roof Valley", "roof", QUAD, 0xff, "", 0],
	"roof_overhang": ["Roof Overhang", "model:roof_overhang", BI, 0xcf, "", 0],
	"roof_overhang_outer_corner": ["Roof Overhang Outer Corner", "model:roof_overhang_outer_corner", UNI, 0x4f, "", 0],
	"roof_overhang_inner_corner": ["Roof Overhang Inner Corner", "model:roof_overhang_inner_corner", UNI, 0xdf, "", 0],
	"cylinder": ["Cylinder", "model:cylinder_full_r8h16", QUAD, 0xff, "", 0],
	"cylinder_half": ["Half Cylinder", "model:cylinder_half_r8h16", BI, 0xcc, "", 0],
	"cylinder_quarter": ["Quarter Cylinder", "model:cylinder_quarter_r8h16", UNI, 0x44, "", 0],
	"cylinder_large_quarter": ["Round Outer Corner", "model:cylinder_quarter_r16h16", UNI, 0xff, "", 0],
	"anticylinder_large_quarter": ["Round Inner Corner", "model:round_inner_corner", UNI, 0xdd, "", 0],
	"pillar": ["Round Pillar", "model:cylinder_r6h16", QUAD, 0x106, "", 0],
	"post": ["Round Post", "model:cylinder_r4h16", QUAD, 0x104, "", 0],
	"pole": ["Round Pole", "model:cylinder_r2h16", QUAD, 0x102, "", 0],
	"bevelled_outer_corner": ["Bevelled Outer Corner", "model:bevelled_outer_corner", UNI, 0x4f, "", 0],
	"bevelled_inner_corner": ["Bevelled Inner Corner", "model:bevelled_inner_corner", UNI, 0xdf, "", 0],
	"pillar_base": ["Round Pillar Base", "model:pillar_base", QUAD, 0xff, "", 0],
	"doric_capital": ["Doric Capital", "model:doric_capital", QUAD, 0xff, "", 0],
	"ionic_capital": ["Ionic Capital", "model:ionic_capital", BI, 0xff, "", 0],
	"corinthian_capital": ["Corinthian Capital", "model:corinthian_capital", QUAD, 0xff, "", 0],
	"doric_triglyph": ["Triglyph", "model:doric_triglyph", BI, 0xff, "lrStraight", 0],
	"doric_triglyph_corner": ["Triglyph Corner", "model:doric_triglyph_corner", BI, 0xff, "lrCorner", 0],
	"doric_metope": ["Metope", "model:doric_metope", BI, 0xff, "lrStraight", 0],
	"architrave": ["Architrave", "model:architrave", BI, 0xff, "lrStraight", 0],
	"architrave_corner": ["Architrave Corner", "model:architrave_corner", UNI, 0xff, "lrCorner", 0],
	"sphere_full": ["Sphere", "model:sphere_full_r8", QUAD, 0xff, "", 0],
	"sphere_half": ["Hemisphere", "model:sphere_half_r8", QUAD, 0x0f, "", 0],
	"sphere_quarter": ["Quarter Sphere", "model:sphere_quarter_r8", BI, 0x0c, "", 0],
	"sphere_eighth": ["Quarter Hemisphere", "model:sphere_eighth_r8", UNI, 0x04, "", 0],
	"sphere_eighth_large": ["Round Outer Corner Cap", "model:sphere_eighth_r16", UNI, 0xff, "", 0],
	"sphere_eighth_large_rev": ["Round Inner Corner Cap", "model:sphere_eighth_r16_rev", UNI, 0xdf, "", 0],
	"roof_overhang_gable_lh": ["Gable Overhang LH", "model:roof_overhang_gable_lh", BI, 0x48, "", 0],
	"roof_overhang_gable_rh": ["Gable Overhang RH", "model:roof_overhang_gable_rh", BI, 0x84, "", 0],
	"roof_overhang_gable_end_lh": ["Gable Overhang LH End", "model:roof_overhang_gable_end_lh", BI, 0x48, "", 0],
	"roof_overhang_gable_end_rh": ["Gable Overhang RH End", "model:roof_overhang_gable_end_rh", BI, 0x48, "", 0],
	"roof_overhang_ridge": ["Ridge Overhang", "model:roof_overhang_gable_ridge", BI, 0x0c, "", 0],
	"roof_overhang_valley": ["Valley Overhang", "model:roof_overhang_gable_valley", BI, 0xcc, "", 0],
	"cornice_lh": ["Cornice LH", "model:cornice_lh", BI, 0x48, "", 0],
	"cornice_rh": ["Cornice RH", "model:cornice_rh", BI, 0x84, "", 0],
	"cornice_end_lh": ["Cornice LH End", "model:cornice_end_lh", BI, 0x48, "", 0],
	"cornice_end_rh": ["Cornice RH End", "model:cornice_end_rh", BI, 0x48, "", 0],
	"cornice_ridge": ["Cornice Ridge", "model:cornice_ridge", BI, 0x0c, "", 0],
	"cornice_valley": ["Cornice Valley", "model:cornice_valley", BI, 0xcc, "", 0],
	"cornice_bottom": ["Cornice Bottom", "model:cornice_bottom", BI, 0x0c, "", 0],
	"arch_d1": ["Arch Diameter 1", "model:arch_d1", BI, 0xff, "", UNDERNEATH],
	"arch_d2": ["Arch Diameter 2", "model:arch_d2", BI, 0xfc, "", UNDERNEATH],
	"arch_d3_a": ["Arch Diameter 3 Part A", "model:arch_d3a", BI, 0xcc, "", UNDERNEATH],
	"arch_d3_b": ["Arch Diameter 3 Part B", "model:arch_d3b", BI, 0xfc, "", UNDERNEATH],
	"arch_d3_c": ["Arch Diameter 3 Part C", "model:arch_d3c", BI, 0xff, "", UNDERNEATH],
	"arch_d4_a": ["Arch Diameter 4 Part A", "model:arch_d4a", BI, 0xcc, "", UNDERNEATH],
	"arch_d4_b": ["Arch Diameter 4 Part B", "model:arch_d4b", BI, 0xfc, "", UNDERNEATH],
	"arch_d4_c": ["Arch Diameter 4 Part C", "model:arch_d4c", BI, 0x0, "", UNDERNEATH],
	"banister_plain_bottom": ["Plain Banister Bottom Transition", "banister:balustrade_stair_plain_bottom", BI, 0x0, "", OFFSET],
	"banister_plain": ["Plain Banister", "banister:balustrade_stair_plain", BI, 0x0, "", OFFSET],
	"banister_plain_top": ["Plain Banister Top Transition", "banister:balustrade_stair_plain_top", BI, 0x0, "", OFFSET],
	"balustrade_fancy": ["Fancy Balustrade", "model:balustrade_fancy", BI, 0x0, "", 0],
	"balustrade_fancy_corner": ["Fancy Corner Balustrade", "model:balustrade_fancy_corner", UNI, 0x0, "", 0],
	"balustrade_fancy_with_newel": ["Fancy Balustrade with Newel", "model:balustrade_fancy_with_newel", BI, 0x0, "", 0],
	"balustrade_fancy_newel": ["Fancy Newel", "model:balustrade_fancy_newel", UNI, 0x0, "", 0],
	"balustrade_plain": ["Plain Balustrade", "model:balustrade_plain", BI, 0x0, "", 0],
	"balustrade_plain_outer_corner": ["Plain Outer Corner Balustrade", "model:balustrade_plain_outer_corner", UNI, 0x0, "", 0],
	"balustrade_plain_with_newel": ["Plain Balustrade with Newel", "model:balustrade_plain_with_newel", BI, 0x0, "", 0],
	"banister_plain_end": ["Plain Banister End", "banister:balustrade_stair_plain_end", BI, 0x0, "", OFFSET],
	"banister_fancy_newel_tall": ["Tall Fancy Newel", "model:balustrade_fancy_newel_tall", UNI, 0x0, "", 0],
	"balustrade_plain_inner_corner": ["Plain Inner Corner Balustrade", "model:balustrade_plain_inner_corner", UNI, 0x0, "", 0],
	"balustrade_plain_end": ["Plain Balustrade End", "banister:balustrade_plain_end", BI, 0x0, "", OFFSET],
	"banister_fancy_bottom": ["Fancy Banister Bottom Transition", "banister:balustrade_stair_fancy_bottom", BI, 0x0, "", OFFSET],
	"banister_fancy": ["Fancy Banister", "banister:balustrade_stair_fancy", BI, 0x0, "", OFFSET],
	"banister_fancy_top": ["Fancy Banister Top Transition", "banister:balustrade_stair_fancy_top", BI, 0x0, "", OFFSET],
	"banister_fancy_end": ["Fancy Banister End", "banister:balustrade_stair_fancy_end", BI, 0x0, "", OFFSET],
	"banister_plain_inner_corner": ["Plain Banister Inner Corner", "model:balustrade_stair_plain_inner_corner", UNI, 0x0, "", 0],
	"stairs": ["Stairs", "model:stairs", BI, 0xcf, "lrStraight", 0],
	"stairs_outer_corner": ["Stairs Outer Corner", "model:stairs_outer_corner", UNI, 0x4f, "lrCorner", 0],
	"stairs_inner_corner": ["Stairs Inner Corner", "model:stairs_inner_corner", UNI, 0xdf, "rlCorner", 0],
	"slope_tile_a1": ["Slope A Start", "roof", BI, 0xcf, "", 0],
	"slope_tile_a2": ["Slope A End", "roof", BI, 0x0f, "", 0],
	"slope_tile_b1": ["Slope B Start", "roof", BI, 0xff, "", 0],
	"slope_tile_b2": ["Slope B Middle", "roof", BI, 0xcf, "", 0],
	"slope_tile_b3": ["Slope B End", "roof", BI, 0x0f, "", 0],
	"slope_tile_c1": ["Slope C 1", "roof", BI, 0xff, "", 0],
	"slope_tile_c2": ["Slope C 2", "roof", BI, 0xcf, "", 0],
	"slope_tile_c3": ["Slope C 3", "roof", BI, 0x0f, "", 0],
	"slope_tile_c4": ["Slope C 4", "roof", BI, 0x0f, "", 0],
	"angled_roof_ridge": ["Angled Roof Ridge", "model:angled_roof_ridge", BI, 0x0f, "", 0],
	"double_roof_tile": ["Double Roof Tile", "model:double_roof_tile", BI, 0xcf, "", 0],
}

# The shape picker's pages (AC's sawbench pages, minus windows / cladding / glow copies).
const PAGES := [
	["Roofing", ["roof_tile", "roof_outer_corner", "roof_inner_corner", "roof_ridge",
		"roof_smart_ridge", "roof_valley", "roof_smart_valley", "roof_overhang",
		"roof_overhang_outer_corner", "roof_overhang_inner_corner", "roof_overhang_gable_lh",
		"roof_overhang_gable_rh", "roof_overhang_gable_end_lh", "roof_overhang_gable_end_rh",
		"roof_overhang_ridge", "roof_overhang_valley", "bevelled_outer_corner",
		"bevelled_inner_corner"]],
	["Slopes & Stairs", ["slope_tile_a1", "slope_tile_a2", "slope_tile_b1", "slope_tile_b2",
		"slope_tile_b3", "slope_tile_c1", "slope_tile_c2", "slope_tile_c3", "slope_tile_c4",
		"angled_roof_ridge", "double_roof_tile", "stairs", "stairs_outer_corner",
		"stairs_inner_corner"]],
	["Rounded", ["cylinder", "cylinder_half", "cylinder_quarter", "cylinder_large_quarter",
		"anticylinder_large_quarter", "pillar", "post", "pole", "sphere_full", "sphere_half",
		"sphere_quarter", "sphere_eighth", "sphere_eighth_large", "sphere_eighth_large_rev"]],
	["Classical", ["pillar_base", "pillar", "doric_capital", "doric_triglyph",
		"doric_triglyph_corner", "doric_metope", "ionic_capital", "corinthian_capital",
		"architrave", "architrave_corner", "cornice_lh", "cornice_rh", "cornice_end_lh",
		"cornice_end_rh", "cornice_ridge", "cornice_valley", "cornice_bottom"]],
	["Arches", ["arch_d1", "arch_d2", "arch_d3_a", "arch_d3_b", "arch_d3_c", "arch_d4_a",
		"arch_d4_b", "arch_d4_c"]],
	["Railings", ["balustrade_plain", "balustrade_plain_outer_corner",
		"balustrade_plain_inner_corner", "balustrade_plain_with_newel", "balustrade_plain_end",
		"banister_plain_top", "banister_plain", "banister_plain_bottom", "banister_plain_end",
		"banister_plain_inner_corner", "balustrade_fancy", "balustrade_fancy_corner",
		"balustrade_fancy_with_newel", "balustrade_fancy_newel", "banister_fancy_top",
		"banister_fancy", "banister_fancy_bottom", "banister_fancy_end",
		"banister_fancy_newel_tall"]],
]

# Named profile sets for model shapes (AC's Generic), indexed by local face 0..5
# (down, up, north, south, west, east). "" = no profile.
const _PROFILE_SETS := {
	"lrStraight": ["", "", "", "", "RightEnd", "LeftEnd"],
	"lrCorner": ["", "", "", "LeftEnd", "RightEnd", ""],
	"rlCorner": ["", "", "RightEnd", "", "", "LeftEnd"],
	"tbOffset": ["OffsetBottom", "OffsetTop", "", "", "", ""],
}
const _OPPOSITE_PROFILES := {
	"Left": "Right", "Right": "Left", "LeftEnd": "RightEnd", "RightEnd": "LeftEnd",
	"OffsetBottom": "OffsetTop", "OffsetTop": "OffsetBottom",
}

static var _local_cache := {}    # id -> { faces: Array, boxes: Array[AABB] } (shape frame)
static var _placed_cache := {}   # "id|slot" -> Array of faces in cell space

# --- Lookup -------------------------------------------------------------------

static func has(id: String) -> bool:
	return TABLE.has(id)

static func name_of(id: String) -> String:
	return str(TABLE[id][0])

static func symmetry_of(id: String) -> int:
	return int(TABLE[id][2])

static func flags_of(id: String) -> int:
	return int(TABLE[id][5])

static func is_banister(id: String) -> bool:
	return str(TABLE[id][1]).begins_with("banister:")

static func slot_count(id: String) -> int:
	return 48 if flags_of(id) & OFFSET else 24

static func make_slot(side: int, turn: int, negative_offset := false) -> int:
	return side * 4 + (turn & 3) + (24 if negative_offset else 0)

static func side_of(slot: int) -> int:
	return (slot % 24) >> 2

static func turn_of(slot: int) -> int:
	return slot & 3

# The slot icons show a shape in: the way it sits when placed on a floor, turned whichever
# of its four ways shows the icon camera (looking from -X, +Y, -Z) the most surface — so a
# corner or an overhang faces you instead of hiding its slopes. Cached.
const _ICON_VIEW := Vector3(-0.9, 1.0, -1.2)
static var _preview_cache := {}

static func preview_slot(id: String) -> int:
	if _preview_cache.has(id):
		return _preview_cache[id]
	var side := 1 if flags_of(id) & UNDERNEATH else 0
	var view := _ICON_VIEW.normalized()
	var best := make_slot(side, 0)
	var best_area := -1.0
	for turn in 4:
		var slot := make_slot(side, turn)
		var area := 0.0
		for f in placed_faces(id, slot):
			var pos: PackedVector3Array = f["pos"]
			var nrm: PackedVector3Array = f["nrm"]
			for t in range(0, pos.size() - 2, 3):
				var n := (nrm[t] + nrm[t + 1] + nrm[t + 2]).normalized()
				var d := n.dot(view)
				if d > 0.0:
					area += 0.5 * (pos[t + 1] - pos[t]).cross(pos[t + 2] - pos[t]).length() * d
		if area > best_area + 0.001:
			best_area = area
			best = slot
	_preview_cache[id] = best
	return best

# --- Orientation --------------------------------------------------------------

# Rotation for (side, turn): AC's Matrix3.sideTurnRotations = sideRotations[side] *
# turnRotations[turn]. AC's rotX/Y/Z are ordinary right-handed rotations, so they map
# straight onto Godot's Basis; entries are snapped to exact 0/±1.
static func rotation(side: int, turn: int) -> Basis:
	var s: Basis
	match side:
		0: s = Basis()
		1: s = _rx(180)
		2: s = _rx(90)
		3: s = _rx(-90) * _ry(180)
		4: s = _rz(-90) * _ry(90)
		_: s = _rz(90) * _ry(-90)
	var b := s * _ry(90 * (turn & 3))
	return Basis(b.x.round(), b.y.round(), b.z.round())

static func _rx(deg: float) -> Basis:
	return Basis(Vector3.RIGHT, deg_to_rad(deg))

static func _ry(deg: float) -> Basis:
	return Basis(Vector3.UP, deg_to_rad(deg))

static func _rz(deg: float) -> Basis:
	return Basis(Vector3.BACK, deg_to_rad(deg))

# Shape frame (block-centered) → cell space (0..1) for a slot, including a banister's shift
# along its own X axis.
static func transform(id: String, slot: int) -> Transform3D:
	var b := rotation(side_of(slot), turn_of(slot))
	var shift := 0.0
	if flags_of(id) & OFFSET:
		shift = -_OFFSET_X if slot >= 24 else _OFFSET_X
	return Transform3D(b, Vector3(0.5, 0.5, 0.5) + b * Vector3(shift, 0, 0))

# --- Placement (AC's Shape.orientOnPlacement / orientFromHitPosition) ----------

# The slot a shape takes when placed against face `face` (the clicked face's outward side)
# of a neighbor. `hit` is the click point relative to the NEW cell's center. `sneak` is the
# mod's sneak modifier (Ctrl in voxyl — Shift is fly-down): it places the base against the
# clicked face (a stair on its side) and skips neighbor matching. `neighbor` is the clicked
# cell's architecture part as { shape, slot }, or {} — lining up with it wins when their
# profiles match (continuing a roof line, a cornice, a stair run).
static func orient_on_placement(id: String, face: int, hit: Vector3, sneak: bool, neighbor: Dictionary) -> int:
	if not sneak and not neighbor.is_empty() and has(str(neighbor.get("shape", ""))):
		var nshape := str(neighbor["shape"])
		var nslot := int(neighbor["slot"])
		var nside := side_of(nslot)
		var nturn := turn_of(nslot)
		# A banister set on top of a stair-like shape follows the stair.
		if is_banister(id) and (face ^ 1) == nside:
			return make_slot(nside, nturn, _offset_negative(nside, nturn, hit))
		var other := profile_global(nshape, nside, nturn, face)
		if not other.is_empty():
			for i in 4:
				var turn := (nturn + i) & 3
				if profiles_match(profile_global(id, nside, turn, face ^ 1), other):
					return make_slot(nside, turn, nslot >= 24)
	return orient_from_hit(id, face, hit, sneak)

static func orient_from_hit(id: String, face: int, hit: Vector3, sneak: bool) -> int:
	var under := (flags_of(id) & UNDERNEATH) != 0
	var up_side := 1 if under else 0
	var down_side := 0 if under else 1
	var side: int
	if face == 1:
		side = up_side
	elif face == 0:
		side = down_side
	elif sneak:
		side = face ^ 1
	elif hit.y > 0.0:
		side = down_side
	else:
		side = up_side
	var turn := turn_for_hit(side, hit, symmetry_of(id))
	var neg := false
	if flags_of(id) & OFFSET:
		neg = _offset_negative(side, turn, hit)
	return make_slot(side, turn, neg)

static func turn_for_hit(side: int, hit: Vector3, sym: int) -> int:
	var h := rotation(side, 0).inverse() * hit
	match sym:
		BI:
			if absf(h.z) > absf(h.x):
				return 2 if h.z < 0.0 else 0
			return 1 if h.x > 0.0 else 3
		UNI:
			if h.z > 0.0:
				return 0 if h.x < 0.0 else 1
			return 2 if h.x > 0.0 else 3
	return 0

static func _offset_negative(side: int, turn: int, hit: Vector3) -> bool:
	return (rotation(side, turn).inverse() * hit).x < 0.0

# The profile a placed shape presents on a world face (AC's Profile.getProfileGlobal), or "".
static func profile_global(id: String, side: int, turn: int, global_face: int) -> String:
	var local_dir: Vector3 = rotation(side, turn).inverse() * (ShapeCatalog.SIDE_VECS[global_face] as Vector3)
	return _profile_local(id, ShapeCatalog.side_from_normal(local_dir))

static func _profile_local(id: String, local_face: int) -> String:
	if not has(id):
		return ""
	if str(TABLE[id][1]) == "roof":
		match id:
			"roof_tile":
				return str({5: "Left", 4: "Right"}.get(local_face, "None"))
			"roof_outer_corner":
				return str({3: "Left", 4: "Right"}.get(local_face, "None"))
			"roof_inner_corner":
				return str({5: "Left", 2: "Right"}.get(local_face, "None"))
			"roof_ridge", "roof_smart_ridge":
				return "Ridge"
			"roof_valley", "roof_smart_valley":
				return "Valley"
		return "None"
	var set_name := "tbOffset" if is_banister(id) else str(TABLE[id][4])
	if _PROFILE_SETS.has(set_name):
		return str(_PROFILE_SETS[set_name][local_face])
	return ""

static func profiles_match(p1: String, p2: String) -> bool:
	if _OPPOSITE_PROFILES.has(p1):
		return _OPPOSITE_PROFILES[p1] == p2
	return p1 == p2

# --- Geometry -----------------------------------------------------------------

# The shape's faces placed in a cell (0..1 space) at `slot`: an Array of
# { pos: PackedVector3Array (3 per triangle), nrm: PackedVector3Array, uv: PackedVector2Array,
#   projected: bool }. `projected` faces take their texture by world position (like a
# microblock); the rest (roof slopes, most model faces) use their own UVs.
static func placed_faces(id: String, slot: int) -> Array:
	var key := "%s|%d" % [id, slot]
	if _placed_cache.has(key):
		return _placed_cache[key]
	var tf := transform(id, slot)
	var out: Array = []
	for f in local_geometry(id).get("faces", []):
		var pos := PackedVector3Array()
		var nrm := PackedVector3Array()
		for p in f["pos"]:
			pos.append(tf * p)
		for n in f["nrm"]:
			nrm.append((tf.basis * n).normalized())
		out.append({"pos": pos, "nrm": nrm, "uv": f["uv"], "projected": f["projected"]})
	_placed_cache[key] = out
	return out

# The shape's hit / footprint boxes placed in a cell (0..1 space) — AC's collision boxes.
static func placed_boxes(id: String, slot: int) -> Array[AABB]:
	var tf := transform(id, slot)
	var out: Array[AABB] = []
	for b in local_geometry(id).get("boxes", []):
		out.append(_xform_box(tf, b))
	return out

static func _xform_box(tf: Transform3D, b: AABB) -> AABB:
	var p0 := tf * b.position
	var p1 := tf * b.end
	var lo := Vector3(minf(p0.x, p1.x), minf(p0.y, p1.y), minf(p0.z, p1.z))
	var hi := Vector3(maxf(p0.x, p1.x), maxf(p0.y, p1.y), maxf(p0.z, p1.z))
	return AABB(lo, hi - lo)

# The shape in its own frame: { faces, boxes }. Cached.
static func local_geometry(id: String) -> Dictionary:
	if _local_cache.has(id):
		return _local_cache[id]
	var geo := {"faces": [], "boxes": []}
	if has(id):
		var src := str(TABLE[id][1])
		if src == "roof":
			geo["faces"] = _roof_faces(id)
		else:
			geo = _load_model(src.get_slice(":", 1))
		var mask_boxes := _mask_boxes(int(TABLE[id][3]))
		if not mask_boxes.is_empty() or (geo["boxes"] as Array).is_empty():
			geo["boxes"] = mask_boxes if not mask_boxes.is_empty() else [AABB(-Vector3.ONE * 0.5, Vector3.ONE)]
	_local_cache[id] = geo
	return geo

# AC's occlusion mask as boxes (shape frame).
static func _mask_boxes(mask: int) -> Array:
	var out: Array = []
	var param := mask & 0xff
	match mask & 0xff00:
		0x000:
			for i in 8:
				if mask & (1 << i):
					var p := Vector3(0.5 if i & 1 else -0.5, 0.5 if i & 4 else -0.5, 0.5 if i & 2 else -0.5)
					var lo := Vector3(minf(0, p.x), minf(0, p.y), minf(0, p.z))
					out.append(AABB(lo, Vector3.ONE * 0.5))
		0x100:
			var r := param / 16.0
			out.append(AABB(Vector3(-r, -0.5, -r), Vector3(2 * r, 1, 2 * r)))
		0x200:
			var r := param / 32.0
			out.append(AABB(Vector3(-0.5, -0.5, -r), Vector3(1, 1, 2 * r)))
	return out

static func _load_model(file: String) -> Dictionary:
	var geo := {"faces": [], "boxes": []}
	var text := FileAccess.get_file_as_string(MODEL_DIR + file + ".objson")
	var data = JSON.parse_string(text) if not text.is_empty() else null
	if not data is Dictionary:
		push_warning("ArchShapes: can't read model %s" % file)
		return geo
	for f in data.get("faces", []):
		var k := int(f.get("texture", 0))
		var verts: Array = f.get("vertices", [])
		var pos := PackedVector3Array()
		var nrm := PackedVector3Array()
		var uv := PackedVector2Array()
		for tri in f.get("triangles", []):
			for idx in tri:
				var c: Array = verts[int(idx)]
				pos.append(Vector3(c[0], c[1], c[2]))
				nrm.append(Vector3(c[3], c[4], c[5]))
				uv.append(Vector2(c[6], c[7]))
		geo["faces"].append({"pos": pos, "nrm": nrm, "uv": uv, "projected": k == 1 or k == 3})
	for b in data.get("boxes", []):
		geo["boxes"].append(AABB(Vector3(b[0], b[1], b[2]), Vector3(b[3] - b[0], b[4] - b[1], b[5] - b[2])))
	return geo

# --- Roof geometry (ported from AC's RenderRoof, in its 0..1 block space) ----------
# Each shape is the mod's no-neighbor form: the "smart" ridge/valley and the valley/ridge
# joins that react to neighbors aren't modeled yet.

const _N_NZ_SLOPE := Vector3(0, 1, -1)
const _N_PZ_SLOPE := Vector3(0, 1, 1)
const _N_PX_SLOPE := Vector3(1, 1, 0)
const _N_NX_SLOPE := Vector3(-1, 1, 0)

static func _roof_faces(id: String) -> Array:
	var f: Array = []
	match id:
		"roof_tile":
			_slope(f, [Vector3(1, 1, 1), Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, 1, 1)],
				[Vector2(0, 0), Vector2(0, 1), Vector2(1, 1), Vector2(1, 0)], _N_NZ_SLOPE)
			_left_triangle(f); _right_triangle(f); _bottom_quad(f); _back_quad(f)
		"roof_outer_corner":
			_slope(f, [Vector3(0, 1, 1), Vector3(1, 0, 0), Vector3(0, 0, 0)],
				[Vector2(1, 0), Vector2(0, 1), Vector2(1, 1)], _N_NZ_SLOPE)
			_slope(f, [Vector3(0, 1, 1), Vector3(1, 0, 1), Vector3(1, 0, 0)],
				[Vector2(0, 0), Vector2(0, 1), Vector2(1, 1)], _N_PX_SLOPE)
			_outer(f, [Vector3(0, 1, 1), Vector3(0, 0, 1), Vector3(1, 0, 1)], Vector3.BACK)
			_right_triangle(f); _bottom_quad(f)
		"roof_inner_corner":
			_slope(f, [Vector3(0, 1, 0), Vector3(0.5, 0.5, 0.5), Vector3(1, 0, 0)],
				[Vector2(1, 0), Vector2(0.5, 0.5), Vector2(1, 1)], _N_PX_SLOPE)
			_slope(f, [Vector3(1, 1, 1), Vector3(1, 0, 0), Vector3(0.5, 0.5, 0.5)],
				[Vector2(0, 0), Vector2(0, 1), Vector2(0.5, 0.5)], _N_NZ_SLOPE)
			_outer(f, [Vector3(0, 1, 0), Vector3(1, 0, 0), Vector3(0, 0, 0)], Vector3.FORWARD)
			_left_triangle(f); _bottom_quad(f)
			_terminate_valley_back(f); _terminate_valley_right(f)
		"roof_ridge":
			_slope(f, [Vector3(1, 0.5, 0.5), Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, 0.5, 0.5)],
				[Vector2(0, 0.5), Vector2(0, 1), Vector2(1, 1), Vector2(1, 0.5)], _N_NZ_SLOPE)
			_slope(f, [Vector3(0, 0.5, 0.5), Vector3(0, 0, 1), Vector3(1, 0, 1), Vector3(1, 0.5, 0.5)],
				[Vector2(0, 0.5), Vector2(0, 1), Vector2(1, 1), Vector2(1, 0.5)], _N_PZ_SLOPE)
			_outer(f, [Vector3(1, 0.5, 0.5), Vector3(1, 0, 1), Vector3(1, 0, 0)], Vector3.RIGHT)
			_outer(f, [Vector3(0, 0.5, 0.5), Vector3(0, 0, 0), Vector3(0, 0, 1)], Vector3.LEFT)
			_bottom_quad(f)
		"roof_smart_ridge":
			var c := Vector3(0.5, 0.5, 0.5)
			var uvs := [Vector2(0.5, 0.5), Vector2(0, 1), Vector2(1, 1)]
			_slope(f, [c, Vector3(1, 0, 1), Vector3(1, 0, 0)], uvs, _N_PX_SLOPE)
			_slope(f, [c, Vector3(0, 0, 0), Vector3(0, 0, 1)], uvs, _N_NX_SLOPE)
			_slope(f, [c, Vector3(0, 0, 1), Vector3(1, 0, 1)], uvs, _N_PZ_SLOPE)
			_slope(f, [c, Vector3(1, 0, 0), Vector3(0, 0, 0)], uvs, _N_NZ_SLOPE)
			_bottom_quad(f)
		"roof_valley":
			_connect_valley_left(f); _connect_valley_right(f)
			_terminate_valley_front(f); _terminate_valley_back(f)
			_bottom_quad(f)
		"roof_smart_valley":
			_terminate_valley_left(f); _terminate_valley_right(f)
			_terminate_valley_front(f); _terminate_valley_back(f)
			_bottom_quad(f)
		"slope_tile_a1": _slope_tile(f, 1.0, 0.5, [[0, 0.5], [0.5, 0.5]], 0.5, 1.0)
		"slope_tile_a2": _slope_tile(f, 0.5, 0.0, [[-1, 0], [0, 0.5]], 0.0, 0.5)
		"slope_tile_b1": _slope_tile(f, 1.0, 2.0 / 3.0, [[0, 2.0 / 3.0], [2.0 / 3.0, 1.0 / 3.0]], 2.0 / 3.0, 1.0)
		"slope_tile_b2": _slope_tile(f, 2.0 / 3.0, 1.0 / 3.0, [[0, 1.0 / 3.0], [1.0 / 3.0, 1.0 / 3.0]], 1.0 / 3.0, 2.0 / 3.0)
		"slope_tile_b3": _slope_tile(f, 1.0 / 3.0, 0.0, [[-1, 0], [0, 1.0 / 3.0]], 0.0, 1.0 / 3.0)
		"slope_tile_c1": _slope_tile(f, 1.0, 0.75, [[0, 0.75], [0.75, 0.25]], 0.75, 1.0)
		"slope_tile_c2": _slope_tile(f, 0.75, 0.5, [[0, 0.5], [0.5, 0.25]], 0.5, 0.75)
		"slope_tile_c3": _slope_tile(f, 0.5, 0.25, [[0, 0.25], [0.25, 0.25]], 0.25, 0.5)
		"slope_tile_c4": _slope_tile(f, 0.25, 0.0, [[-1, 0], [0, 0.25]], 0.0, 0.25)
	return f

# A slope tile (AC's renderSlopeXN): the sloped top from height `start` at the back (+Z) to
# `end` at the front, side walls (a quad of `sides[0]` = [offset, height], skipped when
# offset < 0, under a triangle of `sides[1]`), a front wall of `front` height, a back wall
# of `back` height (1 → the full back quad) and the bottom.
static func _slope_tile(f: Array, start: float, end: float, sides: Array, front: float, back: float) -> void:
	_slope(f, [Vector3(1, start, 1), Vector3(1, end, 0), Vector3(0, end, 0), Vector3(0, start, 1)],
		[Vector2(0, 0), Vector2(0, 1), Vector2(1, 1), Vector2(1, 0)], Vector3(0, 1, end - start))
	var quad: Array = sides[0]
	var tri: Array = sides[1]
	if float(quad[0]) >= 0.0:
		var o: float = quad[0]
		var h: float = quad[1]
		_outer(f, [Vector3(0, o + h, 0), Vector3(0, o, 0), Vector3(0, o, 1), Vector3(0, o + h, 1)], Vector3.LEFT)
		_outer(f, [Vector3(1, o + h, 1), Vector3(1, o, 1), Vector3(1, o, 0), Vector3(1, o + h, 0)], Vector3.RIGHT)
	var to: float = tri[0]
	var th: float = tri[1]
	_outer(f, [Vector3(1, to + th, 1), Vector3(1, to, 1), Vector3(1, to, 0)], Vector3.RIGHT)
	_outer(f, [Vector3(0, to + th, 1), Vector3(0, to, 0), Vector3(0, to, 1)], Vector3.LEFT)
	if front > 0.0:
		_outer(f, [Vector3(1, front, 0), Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, front, 0)], Vector3.FORWARD)
	_outer(f, [Vector3(0, back, 1), Vector3(0, 0, 1), Vector3(1, 0, 1), Vector3(1, back, 1)], Vector3.BACK)
	_bottom_quad(f)

static func _left_triangle(f: Array) -> void:
	_outer(f, [Vector3(1, 1, 1), Vector3(1, 0, 1), Vector3(1, 0, 0)], Vector3.RIGHT)

static func _right_triangle(f: Array) -> void:
	_outer(f, [Vector3(0, 1, 1), Vector3(0, 0, 0), Vector3(0, 0, 1)], Vector3.LEFT)

static func _bottom_quad(f: Array) -> void:
	_outer(f, [Vector3(0, 0, 1), Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(1, 0, 1)], Vector3.DOWN)

static func _back_quad(f: Array) -> void:
	_outer(f, [Vector3(0, 1, 1), Vector3(0, 0, 1), Vector3(1, 0, 1), Vector3(1, 1, 1)], Vector3.BACK)

static func _front_quad(f: Array) -> void:
	_outer(f, [Vector3(1, 1, 0), Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, 1, 0)], Vector3.FORWARD)

static func _left_quad(f: Array) -> void:
	_outer(f, [Vector3(1, 1, 1), Vector3(1, 0, 1), Vector3(1, 0, 0), Vector3(1, 1, 0)], Vector3.RIGHT)

static func _right_quad(f: Array) -> void:
	_outer(f, [Vector3(0, 1, 0), Vector3(0, 0, 0), Vector3(0, 0, 1), Vector3(0, 1, 1)], Vector3.LEFT)

static func _connect_valley_left(f: Array) -> void:
	var c := Vector3(0.5, 0.5, 0.5)
	_slope(f, [c, Vector3(1, 0.5, 0.5), Vector3(1, 1, 0)], [Vector2(0.5, 0.5), Vector2(1, 0.5), Vector2(1, 0)], _N_PZ_SLOPE)
	_slope(f, [c, Vector3(1, 1, 1), Vector3(1, 0.5, 0.5)], [Vector2(0.5, 0.5), Vector2(0, 0), Vector2(0, 0.5)], _N_NZ_SLOPE)
	for t in [[Vector3(1, 1, 1), Vector3(1, 0, 1)], [Vector3(1, 0, 1), Vector3(1, 0, 0)], [Vector3(1, 0, 0), Vector3(1, 1, 0)]]:
		_outer(f, [t[0], t[1], Vector3(1, 0.5, 0.5)], Vector3.RIGHT)

static func _connect_valley_right(f: Array) -> void:
	var c := Vector3(0.5, 0.5, 0.5)
	_slope(f, [c, Vector3(0, 1, 0), Vector3(0, 0.5, 0.5)], [Vector2(0.5, 0.5), Vector2(0, 0), Vector2(0, 0.5)], _N_PZ_SLOPE)
	_slope(f, [c, Vector3(0, 0.5, 0.5), Vector3(0, 1, 1)], [Vector2(0.5, 0.5), Vector2(1, 0.5), Vector2(1, 0)], _N_NZ_SLOPE)
	for t in [[Vector3(0, 0, 1), Vector3(0, 1, 1)], [Vector3(0, 0, 0), Vector3(0, 0, 1)], [Vector3(0, 1, 0), Vector3(0, 0, 0)]]:
		_outer(f, [t[0], t[1], Vector3(0, 0.5, 0.5)], Vector3.LEFT)

static func _terminate_valley_left(f: Array) -> void:
	_slope(f, [Vector3(1, 1, 0), Vector3(0.5, 0.5, 0.5), Vector3(1, 1, 1)],
		[Vector2(0, 0), Vector2(0.5, 0.5), Vector2(1, 0)], _N_NX_SLOPE)
	_left_quad(f)

static func _terminate_valley_right(f: Array) -> void:
	_slope(f, [Vector3(0, 1, 1), Vector3(0.5, 0.5, 0.5), Vector3(0, 1, 0)],
		[Vector2(0, 0), Vector2(0.5, 0.5), Vector2(1, 0)], _N_PX_SLOPE)
	_right_quad(f)

static func _terminate_valley_front(f: Array) -> void:
	_slope(f, [Vector3(0, 1, 0), Vector3(0.5, 0.5, 0.5), Vector3(1, 1, 0)],
		[Vector2(0, 0), Vector2(0.5, 0.5), Vector2(1, 0)], _N_PZ_SLOPE)
	_front_quad(f)

static func _terminate_valley_back(f: Array) -> void:
	_slope(f, [Vector3(1, 1, 1), Vector3(0.5, 0.5, 0.5), Vector3(0, 1, 1)],
		[Vector2(0, 0), Vector2(0.5, 0.5), Vector2(1, 0)], _N_NZ_SLOPE)
	_back_quad(f)

# A sloped (explicit-UV) face, fanned into triangles, in RenderRoof's 0..1 space.
static func _slope(f: Array, verts: Array, uvs: Array, n: Vector3) -> void:
	_face(f, verts, uvs, n, false)

# An outer (position-projected) face.
static func _outer(f: Array, verts: Array, n: Vector3) -> void:
	var uvs: Array = []
	uvs.resize(verts.size())
	uvs.fill(Vector2.ZERO)
	_face(f, verts, uvs, n, true)

static func _face(f: Array, verts: Array, uvs: Array, n: Vector3, projected: bool) -> void:
	var pos := PackedVector3Array()
	var nrm := PackedVector3Array()
	var uv := PackedVector2Array()
	var nn := n.normalized()
	for i in range(1, verts.size() - 1):
		for k in [0, i, i + 1]:
			pos.append((verts[k] as Vector3) - Vector3(0.5, 0.5, 0.5))
			nrm.append(nn)
			uv.append(uvs[k])
	f.append({"pos": pos, "nrm": nrm, "uv": uv, "projected": projected})
