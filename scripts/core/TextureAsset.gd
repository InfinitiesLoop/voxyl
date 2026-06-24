class_name TextureAsset
extends Resource

# One texture's pixels + metadata, in voxyl's neutral (non-MC) format. A shared
# library entry: a BlockModel binds its texture keys to TextureAsset *ids*, so the
# same PNG imported once is referenced by many models (decision 5).
#
# Phase 0 scope: the resource type and its schema exist, and `average_color` is
# the planning hint that feeds BlockType.color (decision 1). Actual pixel loading,
# the storage accessor, and animated rendering land in Phase 1 — `image_path` is
# resolved through the storage accessor then, not here.
#
# Animation mirrors Minecraft's layout (a vertical strip of frames) so the
# importer is a near-direct translator, but nothing here is MC-specific.

enum Transparency { OPAQUE, CUTOUT, TRANSLUCENT }
enum TintSource { NONE, FOLIAGE, GRASS, FIXED }

@export var id: String = ""
@export var image_path: String = ""          # resolved via the storage accessor (Phase 1)

# Animation — frames stacked vertically in image_path; advanced at render time.
@export var frame_count: int = 1
@export var frame_time: float = 0.0          # seconds per frame (0 = static)
@export var frame_order: Array[int] = []     # explicit sequence; empty = 0..frame_count-1
@export var interpolate: bool = false

# Tinting is a Phase 4 concern; the field exists now so the schema is stable.
@export var tint_source: TintSource = TintSource.NONE
@export var fixed_tint: Color = Color.WHITE

@export var transparency: Transparency = Transparency.OPAQUE

# Sampled once at import; mirrored into BlockType.color so the 2D/planning views
# stay fast and the "undecided" state keeps working without touching pixels.
@export var average_color: Color = Color(0.5, 0.5, 0.5)

func is_animated() -> bool:
	return frame_count > 1 and frame_time > 0.0
