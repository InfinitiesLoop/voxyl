class_name SchematicaWriter
extends RefCounted

# Assembles the real Schematica .schematic NBT structure and serializes it via NbtWriter — no
# traversal or palette resolution here, see SchematicaExporter for that. Format confirmed
# against Schematica's own reader and real-world .schematic files:
#   Width/Height/Length : Short
#   Materials            : String, "Alpha" (post-Classic MC — every MC version this importer
#                           targets)
#   Blocks               : ByteArray[Width*Height*Length], index (y*Length+z)*Width+x, low 8
#                           bits of each cell's LOCAL id (SchematicaMapping resolves it)
#   AddBlocks            : ByteArray, present only when some local id needs bits 8-11 — one
#                           nibble per block, two blocks packed per byte (low nibble = the
#                           even index, high nibble = the odd one)
#   Data                 : ByteArray[same size], each cell's metadata value
#   Entities             : List<Compound>, always empty — voxyl has no MC entity concept
#   TileEntities         : List<Compound>, one per FMP/AC/GT part cell (empty for a whole-
#                           block-only export)
#   SchematicaMapping    : Compound {"<registry>": Short(local_id)} — THIS file's own local
#                           ids, chosen when writing (from 1; 0 means air/empty), so the file
#                           never depends on any particular instance's numeric block-id table.
#   BlockMapping/         : The same mapping again, under the tag name GTNH's own WorldEdit
#   ItemMapping             fork actually reads (worldedit-gtnh PR #14): on paste it rebuilds
#                           each stored id's registry name from BlockMapping, then re-resolves
#                           that name against whatever id the PASTING world's session currently
#                           has — the fix for 1.7.10's block ids shifting between sessions
#                           (mod load order isn't stable), confirmed against a real WorldEdit-
#                           saved .schematic and worldedit-gtnh's source. Without this tag,
#                           WorldEdit falls back to the raw stored id verbatim, which can collide
#                           with an unrelated mod's block in a different session (this is what
#                           was raining ModernMarkings items on paste). ItemMapping is the same
#                           idea for item ids; voxyl never places by item, so it's always empty.

static func write(size: Vector3i, local_ids: PackedInt32Array, metas: PackedByteArray,
		mapping: Dictionary, tile_entities: Array = []) -> PackedByteArray:
	var volume := local_ids.size()
	var blocks := PackedByteArray()
	blocks.resize(volume)
	var needs_add := false
	for id in local_ids:
		if id > 255:
			needs_add = true
			break
	var add_blocks := PackedByteArray()
	if needs_add:
		add_blocks.resize((volume + 1) >> 1)
	for i in volume:
		var id: int = local_ids[i]
		blocks[i] = id & 0xFF
		if needs_add and id > 255:
			var nib := (id >> 8) & 0xF
			var byte_idx := i >> 1
			if i % 2 == 0:
				add_blocks[byte_idx] = (add_blocks[byte_idx] & 0xF0) | nib
			else:
				add_blocks[byte_idx] = (add_blocks[byte_idx] & 0x0F) | (nib << 4)

	var mapping_compound := {}
	for registry in mapping:
		mapping_compound[str(registry)] = NbtWriter.tag_short(int(mapping[registry]))

	var root := {
		"Width": NbtWriter.tag_short(size.x),
		"Height": NbtWriter.tag_short(size.y),
		"Length": NbtWriter.tag_short(size.z),
		"Materials": NbtWriter.tag_string("Alpha"),
		"Blocks": NbtWriter.tag_byte_array(blocks),
		"Data": NbtWriter.tag_byte_array(metas),
		"Entities": NbtWriter.tag_list(NbtWriter.TYPE_COMPOUND, []),
		"TileEntities": NbtWriter.tag_list(NbtWriter.TYPE_COMPOUND, tile_entities),
		"SchematicaMapping": NbtWriter.tag_compound(mapping_compound),
		"BlockMapping": NbtWriter.tag_compound(mapping_compound.duplicate()),
		"ItemMapping": NbtWriter.tag_compound({}),
	}
	if needs_add:
		root["AddBlocks"] = NbtWriter.tag_byte_array(add_blocks)
	return NbtWriter.write_file("Schematic", root)
