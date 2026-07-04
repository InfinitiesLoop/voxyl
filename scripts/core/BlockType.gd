class_name BlockType
extends Resource

# A concrete, named block — "Stone", "Spruce Log", "Brick", etc.
# color is a planning hint; future versions will support textures here instead.
#
# shape is a *visual* property and lives here in the palette/material layer, never
# in the voxel data: the data only records that a cell is placed and how it's
# oriented. A given orientation is rendered as a cube, a slab, stairs, … purely
# based on the block type the palette currently maps the cell to. Swap the
# palette and the same data renders with entirely different shapes — the
# data/palette decoupling holds.
#
# model_id is the additive texture/model path (decision 2): when set, it
# references a BlockModel in the workspace library that supplies the geometry
# (and, later, textures). When empty, `shape` selects a built-in model and
# `color` is the rendered material — the planning/"undecided" path stays first-
# class. color is also the sampled average of an imported texture (decision 1),
# so the fast 2D/planning views never need pixels.
#
# state_map is the optional, nested orientation → model binding (decision 5): an
# importer fills it from a Minecraft blockstate's `variants` so different facings
# can resolve to different models (stairs, logs, …). It still references models by
# id. When null, model_id is the single model rendered at every orientation (today's
# behavior — the view rotates it via Orientation.basis_of). model_id should mirror
# state_map.default_model_id() so non-orientation-aware code still resolves geometry.
#
# tint is the biome-color hint (Phase 4): a per-block visual property in the
# material layer. Minecraft tints grayscale "tintindex" textures (grass, leaves,
# water, foliage) from biome colormaps; voxyl has no biomes, so the importer bakes
# the MC plains/default-biome color here and the 3D view multiplies it into faces
# that carry a tint_index. WHITE is the identity (no tint) — every untinted block
# stays WHITE, so the field is invisible unless a model actually opts in via
# tint_index. Decoupled like color: edit it freely without touching voxel data.
enum Shape { FULL, SLAB, STAIRS }

@export var name: String = ""
# The source namespace this block was imported from (e.g. "ztones", "minecraft"), kept
# even when namespace-split importing routes the block into a same-named library and
# leaves `name` bare (see ImportService.name_for) — otherwise that provenance would be
# lost the moment split-import strips it from the name. Purely a search/lookup aid, never
# an identity: block types are still looked up by `name` alone within their library.
# Named source_namespace, not namespace — "namespace" is a reserved GDScript keyword
# (reserved for a future feature) and using it as a property name fails to parse.
@export var source_namespace: String = ""
# Per-library sort order for the Block Types grid (decision 4). Set by the owning
# BlockLibrary on add/import (next_order); the grid shows one library at a time sorted
# by (order, name). Purely a presentation hint — never touches voxel data.
@export var order: int = 0
@export var color: Color = Color(0.5, 0.5, 0.5)
@export var shape: Shape = Shape.FULL
@export var model_id: String = ""
@export var state_map: BlockStateMap = null
@export var tint: Color = Color.WHITE
