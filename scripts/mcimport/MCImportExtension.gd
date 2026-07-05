class_name MCImportExtension
extends RefCounted

# A mod-specific post-import "healer". The generic MC importers (MCImporter, MCFlatImporter)
# translate every namespace the same neutral way; some mods, though, model their blocks in
# ways neutral synthesis can't recover — GregTech composites a machine from a tier hull + a
# transparent overlay in Java, and names it from a metadata table, so a texture-only import
# leaves invisible overlay cubes with cryptic names. An extension runs AFTER the presumptive
# import of a namespace, with the freshly-imported library + source in hand (an MCHealContext),
# and is free to add better blocks and remove the junk ones. All the mod knowledge lives in the
# extension; the core import pipeline stays entirely mod-agnostic (principle 4).
#
# It is still a reader of the user's own assets (decision 4) — it just reads more of the same
# source (extra textures, the mod's lang files) and bundles nothing.
#
# Register a subclass by the namespace it handles in _factories(); ImportService looks one up
# per imported namespace and calls heal(ctx). No match → nothing runs, the presumptive import
# stands unchanged.

# Extension subclass script PATHS (not class_names). Referencing paths as strings, and load()-ing
# them in for_namespace, deliberately avoids naming the subclasses here: a subclass
# `extends MCImportExtension`, so a class-name reference back would be a circular parse dependency
# (neither would compile). This keeps the dependency one-directional. Each entry may handle many
# namespaces — an extension declares which via handles() — so one "pack" (e.g. all of GTNH) can be
# a single script. New mods/packs: add the script path here.
const _EXTENSIONS := [
	"res://scripts/mcimport/GTNHExtension.gd",
]

# A fresh instance of the extension that handles `ns`, or null when no registered extension does
# (the namespace then imports the plain neutral way). First match wins.
static func for_namespace(ns: String) -> MCImportExtension:
	for path in _EXTENSIONS:
		var script := load(path) as GDScript
		if script == null:
			continue
		var ext := script.new() as MCImportExtension
		if ext != null and ext.handles(ns):
			return ext
	return null

# Whether this extension handles `ns`. Override in a subclass; the base handles nothing.
func handles(_ns: String) -> bool:
	return false

# Reshape the just-imported namespace in place. Override in a subclass; the base is a no-op.
func heal(_ctx: MCHealContext) -> void:
	pass
