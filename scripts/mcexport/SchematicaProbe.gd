class_name SchematicaProbe
extends RefCounted

# Read-only diagnostic: parses an existing .schematic file (this exporter's own output, or a
# reference file) into a compact summary — dimensions, the SchematicaMapping table, and a
# per-registry block-count histogram — for confirming a written file's shape without a full
# round-trip import (schematic -> prefab import stays out of scope, see .plans/prefabs.md).

# The summary Dictionary, or null if `bytes` isn't a well-formed Schematica file.
static func probe(bytes: PackedByteArray) -> Variant:
	var root: Variant = NbtReader.read_file(bytes)
	if root == null:
		return null
	var fields: Dictionary = root["value"]
	if not (fields.has("Width") and fields.has("Height") and fields.has("Length") and fields.has("Blocks")):
		return null
	var width: int = fields["Width"]["value"]
	var height: int = fields["Height"]["value"]
	var length: int = fields["Length"]["value"]
	var blocks: PackedByteArray = fields["Blocks"]["value"]
	var add_blocks: PackedByteArray = fields["AddBlocks"]["value"] if fields.has("AddBlocks") else PackedByteArray()

	var mapping := {}        # registry -> local id, straight from SchematicaMapping
	if fields.has("SchematicaMapping"):
		var mc: Dictionary = fields["SchematicaMapping"]["value"]
		for registry in mc:
			mapping[registry] = int(mc[registry]["value"])
	var id_to_registry := {}
	for registry in mapping:
		id_to_registry[mapping[registry]] = registry

	var histogram := {}      # registry (or "id <n>" when the mapping doesn't cover it) -> count
	for i in blocks.size():
		var id: int = blocks[i]
		if not add_blocks.is_empty():
			var nib: int = (add_blocks[i >> 1] & 0xF) if i % 2 == 0 else ((add_blocks[i >> 1] >> 4) & 0xF)
			id = id | (nib << 8)
		if id == 0:
			continue
		var key: String = id_to_registry[id] if id_to_registry.has(id) else "id %d" % id
		histogram[key] = int(histogram.get(key, 0)) + 1

	var tile_entities: Array = fields["TileEntities"]["value"] if fields.has("TileEntities") else []
	return {
		"dimensions": Vector3i(width, height, length),
		"mapping": mapping,
		"histogram": histogram,
		"tile_entity_count": tile_entities.size(),
	}
