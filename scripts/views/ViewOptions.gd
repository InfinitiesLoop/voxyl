class_name ViewOptions
extends RefCounted

# The one registry of 3D render options. The view toolbar builds its dropdowns from it,
# agent RenderSpecs are checked against it, and View3D applies it — so adding a mode is one
# entry here plus its look in View3D, and it shows up in the toolbar, captures and the MCP
# schema together. Pure lens settings: nothing here ever touches voxel data or palettes.

const OPTIONS := [
	{"id": "mode", "label": "Render", "default": "textured", "choices": [
		["textured", "Textured", "Blocks as the palette maps them"],
		["intent", "Intent", "Each semantic in its own flat color — structure, no materials"],
		["clay", "Clay", "One neutral material: form and shadow only"],
		["outline", "Outline", "Flat fill with dark feature edges - hidden-line drawing"],
		["xray", "X-ray", "Faces at low opacity plus every edge - see the interior"],
		["wire", "Wire", "Feature edges only, drawn through everything, colored by semantic"],
	]},
	{"id": "lighting", "label": "Lighting", "default": "app", "choices": [
		["app", "App", "Voxyl's night lighting"],
		["studio", "Studio", "Bright, even light from every side — undersides readable"],
		["flat", "Flat", "No shading"],
	]},
	{"id": "projection", "label": "Projection", "default": "perspective", "choices": [
		["perspective", "Perspective", ""],
		["orthographic", "Orthographic", "No perspective: judge proportions and depth steps"],
	]},
	{"id": "background", "label": "Background", "default": "app", "toolbar": false, "choices": [
		["app", "App", "Sky and ground grid"],
		["plain", "Plain", "A flat neutral backdrop"],
	]},
]

static func defaults() -> Dictionary:
	var d := {}
	for o in OPTIONS:
		d[o["id"]] = o["default"]
	return d

static func option(id: String) -> Dictionary:
	for o in OPTIONS:
		if o["id"] == id:
			return o
	return {}

static func values(id: String) -> PackedStringArray:
	var out: PackedStringArray = []
	for c in option(id).get("choices", []):
		out.append(c[0])
	return out

# "" if `spec` ({id: value}) only uses known options and values, else what's wrong.
static func check(spec: Dictionary) -> String:
	for k in spec:
		var o := option(str(k))
		if o.is_empty():
			return "unknown render option '%s' (%s)" % [k, ", ".join(OPTIONS.map(func(x: Dictionary) -> String: return x["id"]))]
		if not str(spec[k]) in values(str(k)):
			return "%s must be one of %s" % [k, ", ".join(values(str(k)))]
	return ""
