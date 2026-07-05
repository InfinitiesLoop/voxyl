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

# namespace -> the extension subclass's script PATH (not its class_name). Referencing the path
# as a string, and load()-ing it in for_namespace, deliberately avoids naming the subclass here:
# a subclass `extends MCImportExtension`, so a class-name reference back to it would be a
# circular parse dependency (neither would compile). This keeps the dependency one-directional.
const _SCRIPTS := {
	"gregtech": "res://scripts/mcimport/GregTechExtension.gd",
}

# A fresh extension instance for `ns`, or null when the namespace imports the plain neutral way.
static func for_namespace(ns: String) -> MCImportExtension:
	var path = _SCRIPTS.get(ns)
	if path == null:
		return null
	var script := load(path) as GDScript
	return script.new() if script != null else null

# Reshape the just-imported namespace in place. Override in a subclass; the base is a no-op.
func heal(_ctx: MCHealContext) -> void:
	pass
