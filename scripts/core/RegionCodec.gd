class_name RegionCodec
extends RefCounted

# A region as text, both ways — the cheapest way for a model (or a person in a text editor)
# to read and write structure. Intent only: characters stand for semantics and parts, never
# materials.
#
#   { origin: [x,y,z], axis: "y", legend: {char: value}, layers: [[row, ...], ...] }
#
# axis "y" (plan view): layers go up from origin.y; each layer's rows run north→south (+Z)
#   from origin.z; each row's characters run west→east (+X) from origin.x.
# axis "z" (elevation seen from the south): layers go north→south from origin.z; rows run
#   top→bottom starting at origin.y (the TOP row's y); characters run west→east.
# axis "x" (elevation seen from the east): layers go west→east from origin.x; rows run
#   top→bottom from origin.y; characters run north→south.
#
# Legend values: "Semantic" (a whole block), {semantic, facing?, top?} (an oriented block),
# or [{semantic, slot}, ...] (a cell of shaped parts, slot by name — ShapeCatalog.slot_name).
# "." and " " = leave untouched, "_" = clear. dump() writes "." for air.

const _PLAIN_FALLBACK := "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*+=?!<>^~"
const _PART_FALLBACK := "abcdefghijklmnopqrstuvwxyz0123456789;:'\"|/\\`,-"

# Cell (layer, row, col) → world position for an axis, given the origin.
static func to_world(axis: String, origin: Vector3i, layer: int, row: int, col: int) -> Vector3i:
	match axis:
		"z": return Vector3i(origin.x + col, origin.y - row, origin.z + layer)
		"x": return Vector3i(origin.x + layer, origin.y - row, origin.z + col)
	return Vector3i(origin.x + col, origin.y + layer, origin.z + row)

# Text of the inclusive box [mn, mx] along `axis`. `entry_shape` (semantic -> shape id) lets
# a part's shape be left out when it's what the semantic places anyway.
static func dump(data: VoxelData, mn: Vector3i, mx: Vector3i, axis := "y", entry_shape := Callable()) -> Dictionary:
	var origin := mn
	var dims := Vector3i.ZERO   # layers, rows, cols
	match axis:
		"z":
			origin = Vector3i(mn.x, mx.y, mn.z)
			dims = Vector3i(mx.z - mn.z + 1, mx.y - mn.y + 1, mx.x - mn.x + 1)
		"x":
			origin = Vector3i(mn.x, mx.y, mn.z)
			dims = Vector3i(mx.x - mn.x + 1, mx.y - mn.y + 1, mx.z - mn.z + 1)
		_:
			axis = "y"
			dims = Vector3i(mx.y - mn.y + 1, mx.z - mn.z + 1, mx.x - mn.x + 1)
	var legend := {}      # char -> value
	var char_of := {}     # cell key -> char
	var used := {".": true, "_": true, " ": true}
	var layers: Array = []
	for l in dims.x:
		var rows: PackedStringArray = []
		for r in dims.y:
			var row := ""
			for c in dims.z:
				var cell := data.get_cell(to_world(axis, origin, l, r, c))
				if cell == null:
					row += "."
					continue
				var key := _cell_key(cell)
				if not char_of.has(key):
					var ch := _pick_char(cell, used)
					used[ch] = true
					char_of[key] = ch
					legend[ch] = _legend_value(cell, entry_shape)
				row += char_of[key]
			rows.append(row)
		layers.append(rows)
	return {"origin": [origin.x, origin.y, origin.z], "axis": axis, "legend": legend, "layers": layers}

static func _cell_key(cell: BlockCell) -> String:
	if cell.is_shaped():
		var parts: Array = VoxelData.pack_parts(cell.parts)
		parts.sort_custom(func(a: Array, b: Array) -> bool: return str(a) < str(b))
		return "p|" + str(parts)
	return "b|%s|%d" % [cell.type_id, cell.orientation]

# Whole blocks get capitals (the semantic's own letters first), part cells lower case.
static func _pick_char(cell: BlockCell, used: Dictionary) -> String:
	var pool := _PART_FALLBACK if cell.is_shaped() else _PLAIN_FALLBACK
	var own := cell.type_id.to_lower() if cell.is_shaped() else cell.type_id.to_upper()
	for ch in own + pool:
		if pool.contains(ch) and not used.has(ch):
			return ch
	return "?"

static func _legend_value(cell: BlockCell, entry_shape: Callable) -> Variant:
	if cell.is_shaped():
		var out: Array = []
		for p in cell.parts:
			var shape := str(p["shape"])
			var v := {"semantic": str(p["semantic"]), "slot": ShapeCatalog.slot_name(shape, int(p["slot"]))}
			if not entry_shape.is_valid() or str(entry_shape.call(str(p["semantic"]))) != shape:
				v["shape"] = shape
			out.append(v)
		return out
	if cell.orientation == 0:
		return cell.type_id
	return {"semantic": cell.type_id,
		"facing": Orientation.NAMES[Orientation.facing_of(cell.orientation)].to_lower(),
		"top": Orientation.is_top(cell.orientation)}

# Edits for text layers. `resolved` maps each legend char to what it places, already
# checked by the caller: {op: "block", semantic, orientation} or {op: "parts", parts: [...]}.
# Unknown characters are listed in `errors`. A parts char resets its cell first (the cell
# becomes exactly those parts), once per cell per batch.
static func edits_from_layers(axis: String, origin: Vector3i, layers: Array, resolved: Dictionary) -> Dictionary:
	var edits: Array = []
	var errors: Array = []
	for l in layers.size():
		var rows: Variant = layers[l]
		if rows is String:
			rows = [rows]
		for r in (rows as Array).size():
			var row := str(rows[r])
			for c in row.length():
				var ch := row[c]
				if ch == "." or ch == " ":
					continue
				var pos := to_world(axis, origin, l, r, c)
				if ch == "_":
					edits.append({"pos": pos, "op": "clear"})
					continue
				if not resolved.has(ch):
					errors.append("layer %d row %d col %d: '%s' isn't in the legend" % [l, r, c, ch])
					continue
				var v: Dictionary = resolved[ch]
				if str(v["op"]) == "parts":
					edits.append({"pos": pos, "op": "reset"})
					for part in v["parts"]:
						edits.append({"pos": pos, "op": "part", "part": part})
				else:
					edits.append({"pos": pos, "op": "block", "semantic": v["semantic"],
						"orientation": int(v.get("orientation", 0))})
	return {"edits": edits, "errors": errors}
