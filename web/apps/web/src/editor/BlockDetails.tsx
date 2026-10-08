import type { Engine } from "../scene/Engine.ts";
import { blockDetail } from "./block-details.ts";
import { BakedIcon } from "./icons.tsx";
import { ShapeIcon } from "./ShapeIcon.tsx";
import { useStore } from "./useStore.ts";

/**
 * The semantic under the crosshair, along the top of the view: a small picture, its name,
 * the palette that look resolves through, the block that look assigns, the block library
 * that block comes from, and a glow line when it glows. A shaped part is drawn on its own,
 * in the semantic's colour. Nothing
 * while the ray is on the ground or the air.
 */
export function BlockDetails({ engine }: { engine: Engine }) {
  const looked = useStore(engine.lookedAt);
  const palettes = useStore(engine.palettes);
  const libraries = useStore(engine.libraries);
  if (!looked) return null;
  const detail = blockDetail(palettes, looked.semantic, libraries);
  if (!detail) return null;
  const preview = looked.shape ? (
    <ShapeIcon
      shape={looked.shape}
      {...(looked.slot !== undefined && { slot: looked.slot })}
      color={detail.color}
      className={detail.glow ? "block-details-preview glow" : "block-details-preview"}
    />
  ) : (
    <BakedIcon
      engine={engine}
      block={detail.blockRef}
      color={detail.color}
      className={detail.glow ? "block-details-preview glow" : "block-details-preview"}
    />
  );
  return (
    <div className="block-details">
      {preview}
      <div className="block-details-copy">
        <div className="block-details-name">{detail.name}</div>
        <div className="block-details-palette">{detail.palette}</div>
        <div className="block-details-block">{detail.block ?? "Undecided"}</div>
        {detail.library && <div className="block-details-library">{detail.library}</div>}
        {detail.glow && <div className="block-details-glow">Glowing</div>}
      </div>
    </div>
  );
}
