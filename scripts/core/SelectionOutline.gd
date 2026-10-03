class_name SelectionOutline
extends RefCounted
## The outline of an exact set of cells, as line segments for any view to draw.
##
## Only the silhouette is returned: an edge of the set's surface is kept where the surface
## turns a corner (convex or concave) and dropped where it continues flat into the next
## cell, so a flat wall is bounded by one loop instead of a grid. Collinear unit edges are
## merged into single segments. Pure data in, data out — views just draw the result.


# Returns a flat list of segment endpoints (start, end, start, end, ...) in cell-corner
# coordinates, i.e. the cell at p spans p .. p + 1.
static func segments(cells: Array) -> PackedVector3Array:
	var picked := {}
	for p: Vector3i in cells:
		picked[p] = true

	# Unit edges keyed by (start corner, axis it runs along); the dict dedupes the edge that
	# a convex corner reaches from both of its faces.
	var units := {}
	for p: Vector3i in cells:
		for a in 3:
			var u := (a + 1) % 3
			var v := (a + 2) % 3
			for s in [-1, 1]:
				var n := Vector3i.ZERO
				n[a] = s
				if picked.has(p + n):
					continue   # not a boundary face
				var plane: int = p[a] + (1 if s > 0 else 0)
				for pair: Array in [[u, v], [v, u]]:
					var side: int = pair[0]   # the edge sits on this side of the face
					var run: int = pair[1]    # and runs along this axis
					for e in [-1, 1]:
						var en := Vector3i.ZERO
						en[side] = e
						# The surface carries on flat into the neighbour: no edge here.
						if picked.has(p + en) and not picked.has(p + en + n):
							continue
						var start := Vector3i.ZERO
						start[a] = plane
						start[side] = p[side] + (1 if e > 0 else 0)
						start[run] = p[run]
						units[Vector4i(start.x, start.y, start.z, run)] = true

	var out := PackedVector3Array()
	for key: Vector4i in units:
		var run: int = key.w
		var back := key
		back[run] -= 1
		if units.has(back):
			continue   # not the first unit of its run
		var end := key
		while units.has(end):
			end[run] += 1
		out.append(Vector3(key.x, key.y, key.z))
		out.append(Vector3(end.x, end.y, end.z))
	return out
