class_name ShapeCatalog
extends RefCounted

# The catalog of sub-block shapes a shaped palette entry can cut its base material into
# (see .plans/shaped-parts.md). Pure geometry + placement math — no materials, no palette,
# no voxel data. A placed part is { semantic, shape, slot }; this file says what `shape`
# and `slot` mean.
#
# Coordinates are cell-local, corner-origin: a full block spans (0,0,0)..(1,1,1), +Y up,
# NORTH = -Z (same as BlockModel). Boxes are AABBs in that space.
#
# The microblock families and their slot numbering are deliberately 1:1 with Forge
# Microblocks' (PartMap / *MicroClass) so placement can be ported exactly and a future
# exporter maps slots straight across — but nothing here names the mod; it's just one
# well-defined way to carve up a cube:
#   Sides (a face slot, and the "side" of a clicked face):
#     0 -Y (down), 1 +Y (up), 2 -Z (north), 3 +Z (south), 4 -X (west), 5 +X (east).
#     side >> 1 is the axis group (0 Y, 1 Z, 2 X); side & 1 is "positive".
#   Axis bits (corners, edges): Y = 1, Z = 2, X = 4.
#   FACE / HOLLOW  slot 0..5  = the side the slab lies against.
#   CORNER         slot 0..7  = axis-bit mask of the positive axes.
#   EDGE           slot 0..11 = 0-3 run along Y (bit0 +Z, bit1 +X), 4-7 along Z (bit0 +X,
#                  bit1 +Y), 8-11 along X (bit0 +Y, bit1 +Z).
#                  slot 12..14 = centered post along axis (slot - 12): 0 Y, 1 Z, 2 X. Only
#                  even sizes have these (a "Post"/"Pillar" clicked in a face's center).
#
# ARCH shapes (roofs, stairs, cylinders, … — see ArchShapes) are the other half: one per
# cell, never shared, in any of 24 orientations. Their slot = side * 4 + turn (+24 for a
# banister's mirrored shift). This file is the one facade both halves are asked through,
# so rules, raycasts, footprints and icons don't care which kind a part is.

enum Family { FACE, HOLLOW, EDGE, CORNER, ARCH }

# id -> { name, family, size (eighths of a block) }. Ids are stable (they're stored on
# every placed part); names are display-only.
const SHAPES := {
	"face1":   {"name": "Cover",        "family": Family.FACE,   "size": 1},
	"face2":   {"name": "Panel",        "family": Family.FACE,   "size": 2},
	"face4":   {"name": "Slab",         "family": Family.FACE,   "size": 4},
	"hollow1": {"name": "Hollow Cover", "family": Family.HOLLOW, "size": 1},
	"hollow2": {"name": "Hollow Panel", "family": Family.HOLLOW, "size": 2},
	"hollow4": {"name": "Hollow Slab",  "family": Family.HOLLOW, "size": 4},
	"edge1":   {"name": "Strip",        "family": Family.EDGE,   "size": 1},
	"edge2":   {"name": "Post",         "family": Family.EDGE,   "size": 2},
	"edge4":   {"name": "Pillar",       "family": Family.EDGE,   "size": 4},
	"corner1": {"name": "Nook",         "family": Family.CORNER, "size": 1},
	"corner2": {"name": "Corner",       "family": Family.CORNER, "size": 2},
	"corner4": {"name": "Notch",        "family": Family.CORNER, "size": 4},
}

# Display order (the shape picker walks this).
const ORDER := [
	"face1", "face2", "face4",
	"hollow1", "hollow2", "hollow4",
	"edge1", "edge2", "edge4",
	"corner1", "corner2", "corner4",
]

const FAMILY_NAMES := {
	Family.FACE: "Faces", Family.HOLLOW: "Hollow faces",
	Family.EDGE: "Edges", Family.CORNER: "Corners", Family.ARCH: "Architecture",
}

# The shape picker's pages: [title, ids]. Microblocks first, then the architecture pages.
static func pages() -> Array:
	var out: Array = [["Microblocks", ORDER]]
	out.append_array(ArchShapes.PAGES)
	return out

# First centered-post slot (EDGE family): 12 + axis group.
const CENTER_SLOT := 12

# Outward unit vector per side.
const SIDE_VECS := [
	Vector3(0, -1, 0), Vector3(0, 1, 0), Vector3(0, 0, -1),
	Vector3(0, 0, 1), Vector3(-1, 0, 0), Vector3(1, 0, 0),
]

# Vector3 component index for an axis group (0 Y, 1 Z, 2 X).
const _AXIS_COMP := [1, 2, 0]

# Axis bit for a Vector3 component index (x=0 → 4, y=1 → 1, z=2 → 2).
const _COMP_BIT := [4, 1, 2]

# The edge between two sides, indexed s1 * 6 + s2 with s1 < s2 (PartMap.edgeBetween).
const _EDGE_BETWEEN := [-1, -1, 8, 10, 4, 5, -1, -1, 9, 11, 6, 7, -1, -1, -1, -1, 0, 2,
	-1, -1, -1, -1, 1, 3]

# --- Lookup -----------------------------------------------------------------

static func has(shape_id: String) -> bool:
	return SHAPES.has(shape_id) or ArchShapes.has(shape_id)

static func name_of(shape_id: String) -> String:
	if SHAPES.has(shape_id):
		return str(SHAPES[shape_id]["name"])
	return ArchShapes.name_of(shape_id) if ArchShapes.has(shape_id) else shape_id

static func family_of(shape_id: String) -> int:
	if SHAPES.has(shape_id):
		return int(SHAPES[shape_id]["family"])
	return Family.ARCH if ArchShapes.has(shape_id) else -1

# Whether parts of this shape keep a whole cell to themselves (architecture shapes).
static func is_exclusive(shape_id: String) -> bool:
	return family_of(shape_id) == Family.ARCH

# Thickness in eighths of a block.
static func size_of(shape_id: String) -> int:
	return int(SHAPES[shape_id]["size"]) if SHAPES.has(shape_id) else 0

static func slot_count(shape_id: String) -> int:
	match family_of(shape_id):
		Family.FACE, Family.HOLLOW: return 6
		Family.CORNER: return 8
		Family.EDGE: return 15 if size_of(shape_id) % 2 == 0 else 12
		Family.ARCH: return ArchShapes.slot_count(shape_id)
	return 0

static func is_valid_slot(shape_id: String, slot: int) -> bool:
	return slot >= 0 and slot < slot_count(shape_id)

static func is_centered(shape_id: String, slot: int) -> bool:
	return family_of(shape_id) == Family.EDGE and slot >= CENTER_SLOT

# The slot used for a shaped entry's icon / preview: whatever reads best from the icon
# camera (which looks from -X,+Y,-Z): a slab lying flat, the front vertical edge, the
# front-bottom corner; an architecture shape standing as it would on a floor.
static func preview_slot(shape_id: String) -> int:
	if family_of(shape_id) == Family.ARCH:
		return ArchShapes.preview_slot(shape_id)
	return 0

# The side (0..5) whose outward vector best matches a normal.
static func side_from_normal(n: Vector3) -> int:
	var ax := absf(n.x); var ay := absf(n.y); var az := absf(n.z)
	if ay >= ax and ay >= az:
		return 1 if n.y > 0.0 else 0
	if az >= ax:
		return 3 if n.z > 0.0 else 2
	return 5 if n.x > 0.0 else 4

static func side_vec(side: int) -> Vector3i:
	var v: Vector3 = SIDE_VECS[side]
	return Vector3i(v)

# --- Edge bit helpers (PartMap) ------------------------------------------------

# Axis bits (Y=1, Z=2, X=4) that vary across edge e's axis group.
static func edge_axis_mask(e: int) -> int:
	match e >> 2:
		0: return 6
		1: return 5
	return 3

# Axis-bit mask of the positive axes of edge e (0..11).
static func unpack_edge_bits(e: int) -> int:
	match e >> 2:
		0: return (e & 3) << 1
		1: return (e & 2) >> 1 | (e & 1) << 2
	return e & 3

static func pack_edge_bits(e: int, bits: int) -> int:
	match e >> 2:
		0: return (e & 0xC) | (bits >> 1)
		1: return (e & 0xC) | (bits & 4) >> 2 | (bits & 1) << 1
	return (e & 0xC) | (bits & 3)

# The edge (0..11) between two non-opposite sides.
static func edge_between(s1: int, s2: int) -> int:
	if s2 < s1:
		var t := s1; s1 = s2; s2 = t
	return _EDGE_BETWEEN[s1 * 6 + s2]

# --- Geometry -----------------------------------------------------------------

# The visible boxes of a placed part, in cell-local space. Empty for an unknown shape or
# an invalid slot. For an architecture shape these are its collision boxes (what you aim
# at and what the 2D view outlines) — its real surface is a triangle mesh (ArchShapes).
static func boxes(shape_id: String, slot: int) -> Array[AABB]:
	var out: Array[AABB] = []
	if not is_valid_slot(shape_id, slot):
		return out
	var d := size_of(shape_id) / 8.0
	match family_of(shape_id):
		Family.ARCH:
			return ArchShapes.placed_boxes(shape_id, slot)
		Family.FACE:
			out.append(_face_box(slot, d))
		Family.HOLLOW:
			out.append_array(_ring_boxes(slot, 0.0, 1.0, 0.25, 0.75, d))
		Family.CORNER:
			out.append(_corner_box(slot, d))
		Family.EDGE:
			out.append(_post_box(slot - CENTER_SLOT, d) if slot >= CENTER_SLOT else _edge_box(slot, d))
	return out

# The union bounds of a part's boxes (what a highlight / hit outline uses).
static func bounds(shape_id: String, slot: int) -> AABB:
	var bs := boxes(shape_id, slot)
	if bs.is_empty():
		return AABB()
	var r: AABB = bs[0]
	for i in range(1, bs.size()):
		r = r.merge(bs[i])
	return r

# A slab of thickness d against `side`.
static func _face_box(side: int, d: float) -> AABB:
	var lo := Vector3.ZERO
	var hi := Vector3.ONE
	var c: int = _AXIS_COMP[side >> 1]
	if side & 1:
		lo[c] = 1.0 - d
	else:
		hi[c] = d
	return AABB(lo, hi - lo)

# Four boxes forming a square ring on a face slab of thickness d: the band between `outer`
# ([o0, o1]) and the centered hole ([i0, i1]) on the two in-plane axes.
static func _ring_boxes(side: int, o0: float, o1: float, i0: float, i1: float, d: float) -> Array[AABB]:
	var slab := _face_box(side, d)
	var c: int = _AXIS_COMP[side >> 1]
	var p: int = (c + 1) % 3
	var q: int = (c + 2) % 3
	var out: Array[AABB] = []
	# [p range, q range] per box.
	var bands := [
		[[o0, o1], [o0, i0]],
		[[o0, o1], [i1, o1]],
		[[o0, i0], [i0, i1]],
		[[i1, o1], [i0, i1]],
	]
	for b in bands:
		var lo := slab.position
		var hi := slab.end
		lo[p] = b[0][0]; hi[p] = b[0][1]
		lo[q] = b[1][0]; hi[q] = b[1][1]
		out.append(AABB(lo, hi - lo))
	return out

static func _corner_box(corner: int, d: float) -> AABB:
	var lo := Vector3.ZERO
	var hi := Vector3(d, d, d)
	for comp in 3:
		if corner & _COMP_BIT[comp]:
			lo[comp] = 1.0 - d
			hi[comp] = 1.0
	return AABB(lo, hi - lo)

static func _edge_box(e: int, d: float) -> AABB:
	var along: int = _AXIS_COMP[e >> 2]
	var bits := unpack_edge_bits(e)
	var lo := Vector3.ZERO
	var hi := Vector3.ONE
	for comp in 3:
		if comp == along:
			continue
		if bits & _COMP_BIT[comp]:
			lo[comp] = 1.0 - d
		else:
			hi[comp] = d
	return AABB(lo, hi - lo)

# A centered post of width d running the full length of axis group `axis`.
static func _post_box(axis: int, d: float) -> AABB:
	var along: int = _AXIS_COMP[axis]
	var lo := Vector3.ONE * (0.5 - d * 0.5)
	var hi := Vector3.ONE * (0.5 + d * 0.5)
	lo[along] = 0.0
	hi[along] = 1.0
	return AABB(lo, hi - lo)

# --- Occlusion geometry (ShapeRules) --------------------------------------------

# Boxes that may overlap other parts as long as each part keeps some sub-voxel of its own
# (FMP's "partial occlusion" boxes). A hollow face uses a thin 1/8 border ring here.
static func partial_boxes(shape_id: String, slot: int) -> Array[AABB]:
	if family_of(shape_id) == Family.HOLLOW and is_valid_slot(shape_id, slot):
		return _ring_boxes(slot, 0.0, 1.0, 0.125, 0.875, size_of(shape_id) / 8.0)
	return boxes(shape_id, slot)

# Boxes nothing else may intersect at all (FMP's "normal occlusion"): a centered post's
# body, and a hollow face's frame between 1/8 and the hole. Empty for everything else.
static func hard_boxes(shape_id: String, slot: int) -> Array[AABB]:
	var out: Array[AABB] = []
	if not is_valid_slot(shape_id, slot):
		return out
	if family_of(shape_id) == Family.HOLLOW:
		return _ring_boxes(slot, 0.125, 0.875, 0.25, 0.75, size_of(shape_id) / 8.0)
	if is_centered(shape_id, slot):
		return boxes(shape_id, slot)
	return out

# --- Placement grids (which slot a click on a face picks) ------------------------

# The slot a click at `vhit` (cell-local hit point) on face `side` of the hit cell picks
# for this shape's family, or -1 for "no slot" — for the EDGE family, -1 means the
# face's center zone (a centered post, if the size allows one).
static func hit_slot(shape_id: String, vhit: Vector3, side: int) -> int:
	match family_of(shape_id):
		Family.FACE: return _face_grid_slot(vhit, side, 0.25)
		Family.HOLLOW: return _face_grid_slot(vhit, side, 0.375)
		Family.CORNER: return _corner_grid_slot(vhit, side)
		Family.EDGE: return _edge_grid_slot(vhit, side)
	return -1

# Signed distance of the hit from the face center along side s's outward vector.
static func _proj(vhit: Vector3, s: int) -> float:
	return (vhit - Vector3(0.5, 0.5, 0.5)).dot(SIDE_VECS[s])

static func _face_grid_slot(vhit: Vector3, side: int, size: float) -> int:
	var s1 := (side + 2) % 6
	var s2 := (side + 4) % 6
	var u := _proj(vhit, s1)
	var v := _proj(vhit, s2)
	if absf(u) < size and absf(v) < size:
		return side ^ 1
	if absf(u) > absf(v):
		return s1 if u > 0.0 else s1 ^ 1
	return s2 if v > 0.0 else s2 ^ 1

static func _corner_grid_slot(vhit: Vector3, side: int) -> int:
	var s1 := ((side & 6) + 3) % 6
	var s2 := ((side & 6) + 5) % 6
	var u := _proj(vhit, s1)
	var v := _proj(vhit, s2)
	var bu := 1 if u >= 0.0 else 0
	var bv := 1 if v >= 0.0 else 0
	var bw := (side & 1) ^ 1
	return bw << (side >> 1) | bu << (s1 >> 1) | bv << (s2 >> 1)

static func _edge_grid_slot(vhit: Vector3, side: int) -> int:
	var s1 := (side + 2) % 6
	var s2 := (side + 4) % 6
	var u := _proj(vhit, s1)
	var v := _proj(vhit, s2)
	if absf(u) < 0.25 and absf(v) < 0.25:
		return -1
	if absf(u) > 0.25 and absf(v) > 0.25:
		return edge_between(s1 if u > 0.0 else s1 ^ 1, s2 if v > 0.0 else s2 ^ 1)
	var s: int
	if absf(u) > absf(v):
		s = s1 if u > 0.0 else s1 ^ 1
	else:
		s = s2 if v > 0.0 else s2 ^ 1
	return edge_between(side ^ 1, s)

# The slot on the far side of the cell from `slot`, mirrored across the clicked face's
# axis — what Ctrl-placement picks (FMP's `opposite`).
static func opposite_slot(shape_id: String, slot: int, side: int) -> int:
	if slot < 0:
		return slot
	match family_of(shape_id):
		Family.FACE, Family.HOLLOW:
			return slot ^ 1
		Family.CORNER:
			return slot ^ (1 << (side >> 1))
		Family.EDGE:
			if slot >= CENTER_SLOT:
				return slot
			return pack_edge_bits(slot, unpack_edge_bits(slot) ^ (1 << (side >> 1)))
	return slot

# Whether Ctrl flips this placement to the opposite slot (FMP's `sneakOpposite`): for a
# face-family part only when it would land flush against the clicked face; always for
# edges and corners.
static func uses_opposite(shape_id: String, slot: int, side: int) -> bool:
	match family_of(shape_id):
		Family.FACE, Family.HOLLOW:
			return slot == (side ^ 1)
	return true

# The grid lines for the family's placement zones on a face, as pairs of 2D points in
# face-plane coordinates (u, v) ∈ [-0.5, 0.5]², where u runs along side (side+2)%6 and v
# along (side+4)%6. The view maps them onto the aimed face.
static func grid_lines(shape_id: String) -> Array:
	if family_of(shape_id) == Family.ARCH:
		return []   # architecture shapes orient from where you click, with no zones to show
	var sq := [
		[Vector2(-0.5, -0.5), Vector2(0.5, -0.5)], [Vector2(0.5, -0.5), Vector2(0.5, 0.5)],
		[Vector2(0.5, 0.5), Vector2(-0.5, 0.5)], [Vector2(-0.5, 0.5), Vector2(-0.5, -0.5)],
	]
	var out: Array = sq.duplicate()
	match family_of(shape_id):
		Family.FACE, Family.HOLLOW:
			var s := 0.25 if family_of(shape_id) == Family.FACE else 0.375
			for c in [Vector2(-1, -1), Vector2(1, -1), Vector2(1, 1), Vector2(-1, 1)]:
				out.append([c * 0.5, c * s])
			out.append([Vector2(-s, -s), Vector2(s, -s)])
			out.append([Vector2(s, -s), Vector2(s, s)])
			out.append([Vector2(s, s), Vector2(-s, s)])
			out.append([Vector2(-s, s), Vector2(-s, -s)])
		Family.CORNER:
			out.append([Vector2(0, -0.5), Vector2(0, 0.5)])
			out.append([Vector2(-0.5, 0), Vector2(0.5, 0)])
		Family.EDGE:
			for k in [-0.25, 0.25]:
				out.append([Vector2(k, -0.5), Vector2(k, 0.5)])
				out.append([Vector2(-0.5, k), Vector2(0.5, k)])
	return out

# --- Rigid rotation (paste) --------------------------------------------------------

# The slot a part lands in after the whole structure turns `steps` quarter-turns clockwise
# (viewed from above) around the vertical axis — same sense as Orientation.rotate_offset_cw.
# Found geometrically: rotate the part's bounds about the cell center and match a slot of
# the same shape with identical bounds.
static func rotate_slot_y(shape_id: String, slot: int, steps: int) -> int:
	steps = ((steps % 4) + 4) % 4
	if steps == 0 or not is_valid_slot(shape_id, slot):
		return slot
	if family_of(shape_id) == Family.ARCH:
		# Turn the orientation itself: find the (side, turn) whose rotation is the old one
		# pre-multiplied by the structure's turn ((x, z) -> (-z, x) is -90° about +Y).
		var want := Basis(Vector3.UP, deg_to_rad(-90.0 * steps)) \
			* ArchShapes.rotation(ArchShapes.side_of(slot), ArchShapes.turn_of(slot))
		for side in 6:
			for turn in 4:
				if ArchShapes.rotation(side, turn).is_equal_approx(want):
					return ArchShapes.make_slot(side, turn, slot >= 24)
		return slot
	var b := bounds(shape_id, slot)
	var lo := b.position - Vector3(0.5, 0.5, 0.5)
	var hi := b.end - Vector3(0.5, 0.5, 0.5)
	for i in steps:
		# (x, z) -> (-z, x), applied to the box's two corners then re-sorted.
		var a := Vector3(-lo.z, lo.y, lo.x)
		var c := Vector3(-hi.z, hi.y, hi.x)
		lo = Vector3(minf(a.x, c.x), a.y, minf(a.z, c.z))
		hi = Vector3(maxf(a.x, c.x), c.y, maxf(a.z, c.z))
	var target := AABB(lo + Vector3(0.5, 0.5, 0.5), hi - lo)
	for s in slot_count(shape_id):
		var cand := bounds(shape_id, s)
		if cand.position.is_equal_approx(target.position) and cand.size.is_equal_approx(target.size):
			return s
	return slot
