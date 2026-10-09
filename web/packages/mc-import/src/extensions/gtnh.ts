// The GT New Horizons pack healer: one extension covering the mods of the pack whose blocks the
// plain roster import can't model well. It declares the namespaces it handles and routes to the
// per-mod healers (one file each). Adding a mod: add its namespace here (the shared junk strip
// then applies) and, if it needs bespoke healing, a healer file and a branch below. Pack data
// that is a table (tiers, dye colours, lang key shapes) stays data inside its mod's file.

import type { Extension } from "../legacy/extension.ts";
import type { HealContext } from "../legacy/heal.ts";
import { healCatwalks } from "./catwalks.ts";
import { healChisel } from "./chisel.ts";
import { healEtfuturum } from "./etfuturum.ts";
import { healExtraUtils } from "./extrautils.ts";
import { healGregtech } from "./gregtech.ts";
import { healProjRed } from "./projred.ts";
import { flagAttachments, stripOverlayJunk } from "./shared.ts";
import { healZtones } from "./ztones.ts";

/** Healed (and junk-stripped). Namespaces as the NEI roster spells them. */
const HEALERS: Readonly<Record<string, (ctx: HealContext) => Promise<void>>> = {
  gregtech: healGregtech,
  etfuturum: healEtfuturum,
  catwalks: healCatwalks,
  chisel: healChisel,
  "ProjRed|Illumination": healProjRed,
  ExtraUtilities: healExtraUtils,
  Ztones: healZtones,
};

/** GregTech's addons share its texture conventions, so they get the junk strip and nothing else. */
const JUNK_ONLY: ReadonlySet<string> = new Set(["ggfab"]);

/** Namespaces handled only for the attachment flags: no healing, no junk strip. */
const ATTACH_ONLY: ReadonlySet<string> = new Set(["minecraft", "GalacticraftCore", "BloodArsenal"]);

export const gtnhExtension: Extension = {
  handles: (ns) => ns in HEALERS || JUNK_ONLY.has(ns) || ATTACH_ONLY.has(ns),

  async heal(ctx) {
    flagAttachments(ctx);
    if (ATTACH_ONLY.has(ctx.ns)) return;
    await HEALERS[ctx.ns]?.(ctx);
    stripOverlayJunk(ctx);
  },
};
