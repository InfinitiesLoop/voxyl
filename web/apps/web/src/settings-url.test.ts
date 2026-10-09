import { CITY_THEMES } from "@voxyl/fixtures";
import { describe, expect, it } from "vitest";
import { readSettings, type Settings, settingsQuery } from "./settings-url.ts";

function settings(patch: Partial<Settings> = {}): Settings {
  return {
    world: "",
    theme: 0,
    lighting: "volume",
    time: 12,
    brightness: 0,
    layout: "single",
    ...patch,
  };
}

describe("settings query", () => {
  it("leaves the home page with a clean url", () => {
    expect(settingsQuery(settings({ world: "city-1m", lighting: "volume" }), true)).toBe("");
    expect(settingsQuery(settings(), false)).toBe("");
  });

  it("keeps only the world when every other setting is a default", () => {
    const params = new URLSearchParams(
      "world=city-1m&chunk=64&theme=concrete&lighting=volume&time=12&brightness=0&layout=single",
    );
    expect(settingsQuery(readSettings(params), false)).toBe("world=city-1m");
  });

  it("records a setting only once it leaves the default", () => {
    const brick = CITY_THEMES.findIndex((t) => t.name === "Brick");
    const query = settingsQuery(
      settings({
        world: "saved:abc",
        theme: brick,
        lighting: "off",
        time: 18.5,
        brightness: 100,
        layout: "rows",
      }),
      false,
    );
    expect(query).toBe(
      "world=saved%3Aabc&theme=brick&lighting=off&time=18.5&brightness=100&layout=rows",
    );
  });

  it("still reads the older names", () => {
    const legacy = readSettings(
      new URLSearchParams("world=pillar&chunk=32&palette=brick&lighting=on&daylight=0&views=split"),
    );
    expect(legacy.world).toBe("pillar");
    expect(legacy.theme).toBe(CITY_THEMES.findIndex((t) => t.name === "Brick"));
    expect(legacy.lighting).toBe("volume");
    expect(legacy.time).toBe(0);
    expect(legacy.layout).toBe("columns");
    expect(readSettings(new URLSearchParams("world=nope")).world).toBe("");
    expect(readSettings(new URLSearchParams("world=pillar")).lighting).toBe("volume");
    expect(readSettings(new URLSearchParams("lighting=off")).lighting).toBe("off");
    expect(readSettings(new URLSearchParams("world=pillar")).brightness).toBe(0);
  });
});
