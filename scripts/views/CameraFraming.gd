class_name CameraFraming
extends RefCounted

# Camera math shared by the 3D views (toolbar camera presets) and agent captures: aim at a
# box of cells from a compass side and an elevation, and back off until it fits the frame.
# Pure math — returns a pose; the caller applies it.
#
# Directions: `from` is where the camera stands, as a compass word (n ne e se s sw w nw) or
# a bearing in degrees clockwise from north. North = -Z, east = +X.
# Elevation: degrees above the horizon, or a word — top (straight down), high (50),
# iso (35.26), mid (30), low (12), level (0), eye (a person standing on the build's floor).

const BEARINGS := {"n": 0.0, "north": 0.0, "ne": 45.0, "e": 90.0, "east": 90.0, "se": 135.0,
	"s": 180.0, "south": 180.0, "sw": 225.0, "w": 270.0, "west": 270.0, "nw": 315.0}
const ELEVATIONS := {"top": 89.0, "high": 50.0, "iso": 35.26, "mid": 30.0, "low": 12.0, "level": 0.0}
const EYE_HEIGHT := 1.62

# Bearing in degrees for a `from` value, or NAN if it isn't one.
static func bearing(from: Variant) -> float:
	if typeof(from) == TYPE_INT or typeof(from) == TYPE_FLOAT:
		return float(from)
	var k := str(from).strip_edges().to_lower()
	if BEARINGS.has(k):
		return BEARINGS[k]
	if k.is_valid_float():
		return k.to_float()
	return NAN

# The horizontal unit vector from the target toward a camera at `bearing_deg`.
static func horizontal(bearing_deg: float) -> Vector3:
	var b := deg_to_rad(bearing_deg)
	return Vector3(sin(b), 0.0, -cos(b))

# The compass word nearest a bearing.
static func compass_word(bearing_deg: float) -> String:
	var words := ["n", "ne", "e", "se", "s", "sw", "w", "nw"]
	return words[int(round(fposmod(bearing_deg, 360.0) / 45.0)) % 8]

# A pose that frames the world-space box `box` (cells [min, max+1]) seen from `bearing_deg`
# at `elevation` (degrees, or "eye" to stand at eye height on `floor_y`). `fov` is vertical,
# in degrees; `aspect` = width / height; `margin` > 1 leaves room around the box. With
# `ortho`, returns an orthographic size instead of relying on distance.
# Returns { pos, target, fov, ortho_size (0 = perspective), distance, elevation }.
static func frame(box: AABB, bearing_deg: float, elevation: Variant, fov: float, aspect: float,
		margin := 1.12, ortho := false, distance := -1.0, floor_y := 0.0) -> Dictionary:
	var target := box.get_center()
	var h := horizontal(bearing_deg)
	var eye := str(elevation) == "eye"
	var elev_deg := 30.0
	if not eye:
		if typeof(elevation) == TYPE_INT or typeof(elevation) == TYPE_FLOAT:
			elev_deg = float(elevation)
		elif ELEVATIONS.has(str(elevation)):
			elev_deg = ELEVATIONS[str(elevation)]
		elif str(elevation).is_valid_float():
			elev_deg = str(elevation).to_float()
		elev_deg = clampf(elev_deg, -89.0, 89.0)
	var dir := (h * cos(deg_to_rad(elev_deg)) + Vector3.UP * sin(deg_to_rad(elev_deg))).normalized()
	var eye_y := floor_y + EYE_HEIGHT
	var pos_at := func(dist: float) -> Vector3:
		if eye:
			return Vector3(target.x + h.x * dist, eye_y, target.z + h.z * dist)
		return target + dir * dist
	var corners: Array[Vector3] = []
	for i in 8:
		corners.append(Vector3(
			box.position.x + box.size.x * (i & 1),
			box.position.y + box.size.y * ((i >> 1) & 1),
			box.position.z + box.size.z * ((i >> 2) & 1)))
	var tan_v := tan(deg_to_rad(fov) * 0.5) / margin
	var tan_h := tan_v * aspect
	if ortho:
		var d_o: float = distance if distance > 0.0 else box.size.length() * 2.0 + 8.0
		var p: Vector3 = pos_at.call(d_o)
		var basis := _look_basis(p, target)
		var half_h := 0.0
		for c in corners:
			var q := c - target
			half_h = maxf(half_h, maxf(absf(q.dot(basis.y)), absf(q.dot(basis.x)) / aspect))
		return {"pos": p, "target": target, "fov": fov, "ortho_size": maxf(1.0, half_h * 2.0 * margin),
			"distance": d_o, "elevation": _elevation_of(p, target)}
	var d := distance
	if d <= 0.0:
		# The smallest distance at which every corner is inside the frustum (binary search —
		# "eye" poses move along a horizontal line, so there's no closed form for both modes).
		var lo := 0.5
		var hi := 2000.0
		for _i in 48:
			var mid := (lo + hi) * 0.5
			if _fits(pos_at.call(mid), target, corners, tan_h, tan_v):
				hi = mid
			else:
				lo = mid
		d = hi
	var pos: Vector3 = pos_at.call(d)
	return {"pos": pos, "target": target, "fov": fov, "ortho_size": 0.0, "distance": d,
		"elevation": _elevation_of(pos, target)}

static func _fits(pos: Vector3, target: Vector3, corners: Array[Vector3], tan_h: float, tan_v: float) -> bool:
	var b := _look_basis(pos, target)
	for c in corners:
		var q := c - pos
		var depth := -q.dot(b.z)
		if depth <= 0.05:
			return false
		if absf(q.dot(b.x)) > tan_h * depth or absf(q.dot(b.y)) > tan_v * depth:
			return false
	return true

# Camera basis looking from pos at target (-Z forward), robust to looking straight down.
static func _look_basis(pos: Vector3, target: Vector3) -> Basis:
	var fwd := (target - pos).normalized()
	var up := Vector3.UP if absf(fwd.dot(Vector3.UP)) < 0.999 else Vector3.BACK
	return Basis.looking_at(fwd, up)

static func _elevation_of(pos: Vector3, target: Vector3) -> float:
	var v := pos - target
	return rad_to_deg(atan2(v.y, Vector2(v.x, v.z).length()))

# Bearing (degrees clockwise from north) of a camera at `pos` looking at `target`.
static func bearing_of(pos: Vector3, target: Vector3) -> float:
	var v := pos - target
	return fposmod(rad_to_deg(atan2(v.x, -v.z)), 360.0)
