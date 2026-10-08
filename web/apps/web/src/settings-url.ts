// What a link records. Defaults stay out of the address bar, and Home records nothing:
// opening voxyl.xyz should stay a clean URL.

import { CITY_THEMES } from "@voxyl/fixtures";
import type { LightingMode } from "@voxyl/session";
import { type LayoutPreset, presetFromParams } from "./editor/layout.ts";
import { NOON, wrapHours } from "./scene/sky-model.ts";
import { sampleKind, savedId, type WorldSource } from "./worlds.ts";

export interface Settings {
  /** A sample's kind, a saved project as "saved:<id>", or "" for none (Home). */
  world: WorldSource;
  /** The city theme of the sample builds (CITY_THEMES). */
  theme: number;
  lighting: LightingMode;
  /** Time of day in hours, 0 (midnight) to 24; 12 is noon. */
  time: number;
  /** Minecraft's Brightness, 0 (Moody) to 100 (Bright); 50 is its default. */
  brightness: number;
  /** Which arrangement of panes is showing. Each pane's kind and time live with the layout. */
  layout: LayoutPreset;
}

const DEFAULT_BRIGHTNESS = 50;

function percent(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

/** `time` in hours; earlier versions had `daylight`, 0 (midnight) to 100 (noon). */
function readTime(params: URLSearchParams): number {
  const time = Number(params.get("time") ?? Number.NaN);
  if (Number.isFinite(time)) return wrapHours(time);
  if (params.has("daylight")) return (percent(params.get("daylight"), 100) / 100) * NOON;
  return NOON;
}

export function readSettings(params: URLSearchParams): Settings {
  const requested = params.get("world") ?? "";
  const world = sampleKind(requested) || savedId(requested) ? requested : "";
  // "palette" is the name earlier versions used.
  const themeName = params.get("theme") ?? params.get("palette");
  const theme = CITY_THEMES.findIndex((t) => t.name.toLowerCase() === themeName?.toLowerCase());
  const lighting = params.get("lighting");
  return {
    world,
    theme: Math.max(0, theme),
    // "on" and "vertex" are from earlier versions; any lighting now means the light volume.
    lighting: lighting === null || lighting === "off" ? "off" : "volume",
    time: readTime(params),
    brightness: percent(params.get("brightness"), DEFAULT_BRIGHTNESS),
    layout: presetFromParams(params) ?? "single",
  };
}

function formatHours(hours: number): string {
  const rounded = Math.round(wrapHours(hours) * 100) / 100;
  return String(rounded);
}

/**
 * The query string (no leading `?`). Empty on Home, and whenever every setting is a default.
 * `chunk` used to be here; mesh chunks are fixed at 64³, so it is ignored.
 */
export function settingsQuery(settings: Settings, home: boolean): string {
  if (home || settings.world === "") return "";
  const params = new URLSearchParams();
  params.set("world", settings.world);
  const theme = CITY_THEMES[settings.theme];
  if (settings.theme !== 0 && theme) params.set("theme", theme.name.toLowerCase());
  if (settings.lighting !== "off") params.set("lighting", settings.lighting);
  const time = formatHours(settings.time);
  if (time !== String(NOON)) params.set("time", time);
  const brightness = Math.round(settings.brightness);
  if (brightness !== DEFAULT_BRIGHTNESS) {
    params.set("brightness", String(Math.min(100, Math.max(0, brightness))));
  }
  if (settings.layout !== "single") params.set("layout", settings.layout);
  return params.toString();
}
