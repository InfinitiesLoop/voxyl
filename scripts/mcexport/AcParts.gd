class_name AcParts
extends RefCounted

# Translates a placed ArchShapes part into ArchitectureCraft's own TileShape tile-entity NBT —
# confirmed against the GTNH fork's real source (common/tile/TileShape.java,
# common/tile/TileArchitecture.java, common/shape/Shape.java, ArchitectureContent.java), not
# guessed:
#   - the world block is "ArchitectureCraft:shape" (ArchitectureContent's blockShape field,
#     registered via GameRegistry.registerBlock — blockShapeSE is a second instance used only
#     for the "(Glow)" duplicate shapes, none of which ShapeCatalog models), always at
#     metadata 0: BlockShape's only metadata-backed property (LIGHT) is never actually set
#     (traced through BlockArchitecture.getMetaFromState's property packing).
#   - the tile entity's registered id is "gcewing.shape" (ArchitectureContent.registerTileEntities,
#     an ordinary GameRegistry.registerTileEntity call — no reflection hack, unlike FMP).
#   - "Shape" (Int) is the enum's own explicit `id` field (Shape.forId), NOT .ordinal() — the
#     id sequence has gaps (windows/cladding/the "SE" glow variants live in the gaps; voxyl
#     doesn't model any of those). SHAPE_ID below is that table, transcribed from Shape.java's
#     real declaration order and cross-checked two independent ways (matching ShapeCatalog's
#     own snake_case ids against the PascalCase enum names, and against the enum's own id
#     column directly).
#   - orientation is two raw bytes stored on the tile, "side" (0-5, the same face numbering
#     ShapeCatalog/ArchShapes already use) and "turn" (0-3, a clockwise quarter-turn about
#     that face's own normal) — exactly ArchShapes' own slot = side*4+turn scheme
#     (Trans3.sideTurn / Matrix3's sideRotations, confirmed to match ArchShapes.rotation()).
#   - the base material is an itemstack-style pair: "BaseName" (registry string) + "BaseData"
#     (metadata int).
#   - a banister's half-block shift ("offsetX", TileArchitecture's own field, 1/16 units) isn't
#     independently re-verified against its write path the way everything else here is — it's
#     derived from ArchShapes' own already-ported local shift (_OFFSET_X = 6/16, negated for
#     the slot >= 24 case), trusting the rest of this file's geometry to port faithfully.

const WORLD_REGISTRY := "ArchitectureCraft:shape"
const TILE_ID := "gcewing.shape"

# ArchShapes id -> ArchitectureCraft's own Shape.id (not ordinal; see header comment).
const SHAPE_ID := {
	"roof_tile": 0, "roof_outer_corner": 1, "roof_inner_corner": 2, "roof_ridge": 3,
	"roof_smart_ridge": 4, "roof_valley": 5, "roof_smart_valley": 6, "roof_overhang": 7,
	"roof_overhang_outer_corner": 8, "roof_overhang_inner_corner": 9, "cylinder": 10,
	"cylinder_half": 11, "cylinder_quarter": 12, "cylinder_large_quarter": 13,
	"anticylinder_large_quarter": 14, "pillar": 15, "post": 16, "pole": 17,
	"bevelled_outer_corner": 18, "bevelled_inner_corner": 19, "pillar_base": 20,
	"doric_capital": 21, "ionic_capital": 22, "corinthian_capital": 23,
	"doric_triglyph": 24, "doric_triglyph_corner": 25, "doric_metope": 26,
	"architrave": 27, "architrave_corner": 28,
	"sphere_full": 33, "sphere_half": 34, "sphere_quarter": 35, "sphere_eighth": 36,
	"sphere_eighth_large": 37, "sphere_eighth_large_rev": 38,
	"roof_overhang_gable_lh": 40, "roof_overhang_gable_rh": 41,
	"roof_overhang_gable_end_lh": 42, "roof_overhang_gable_end_rh": 43,
	"roof_overhang_ridge": 44, "roof_overhang_valley": 45,
	"cornice_lh": 50, "cornice_rh": 51, "cornice_end_lh": 52, "cornice_end_rh": 53,
	"cornice_ridge": 54, "cornice_valley": 55, "cornice_bottom": 56,
	"arch_d1": 61, "arch_d2": 62, "arch_d3_a": 63, "arch_d3_b": 64, "arch_d3_c": 65,
	"arch_d4_a": 66, "arch_d4_b": 67, "arch_d4_c": 68,
	"banister_plain_bottom": 70, "banister_plain": 71, "banister_plain_top": 72,
	"balustrade_fancy": 73, "balustrade_fancy_corner": 74,
	"balustrade_fancy_with_newel": 75, "balustrade_fancy_newel": 76,
	"balustrade_plain": 77, "balustrade_plain_outer_corner": 78,
	"balustrade_plain_with_newel": 79, "banister_plain_end": 80,
	"banister_fancy_newel_tall": 81, "balustrade_plain_inner_corner": 82,
	"balustrade_plain_end": 83, "banister_fancy_bottom": 84, "banister_fancy": 85,
	"banister_fancy_top": 86, "banister_fancy_end": 87,
	"banister_plain_inner_corner": 88,
	"stairs": 91, "stairs_outer_corner": 92, "stairs_inner_corner": 93,
	"slope_tile_a1": 94, "slope_tile_a2": 95, "slope_tile_b1": 96, "slope_tile_b2": 97,
	"slope_tile_b3": 98, "slope_tile_c1": 99, "slope_tile_c2": 100, "slope_tile_c3": 101,
	"slope_tile_c4": 102, "angled_roof_ridge": 115, "double_roof_tile": 116,
}

# The TileShape tile entity compound for one placed part, or {} if `bt` carries no confirmed
# Minecraft identity, or the shape has no known AC id — never guessed.
static func tile_tag(pos: Vector3i, shape_id: String, slot: int, bt: BlockType) -> Dictionary:
	if not SHAPE_ID.has(shape_id) or not McId.has_registry(bt):
		return {}
	var out := {
		"id": NbtWriter.tag_string(TILE_ID),
		"x": NbtWriter.tag_int(pos.x), "y": NbtWriter.tag_int(pos.y), "z": NbtWriter.tag_int(pos.z),
		"Shape": NbtWriter.tag_int(SHAPE_ID[shape_id]),
		"side": NbtWriter.tag_byte(ArchShapes.side_of(slot)),
		"turn": NbtWriter.tag_byte(ArchShapes.turn_of(slot)),
		"BaseName": NbtWriter.tag_string(McId.get_registry(bt)),
		"BaseData": NbtWriter.tag_int(McId.get_mc_meta(bt)),
	}
	if ArchShapes.flags_of(shape_id) & ArchShapes.OFFSET:
		out["offsetX"] = NbtWriter.tag_byte(-6 if slot >= 24 else 6)
	return out
