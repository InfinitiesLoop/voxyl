import { fileIn, subdir } from "@voxyl/mc-import";
import { describe, expect, it } from "vitest";
import { fileSource, filesDir, type PickedFile, pickedFiles } from "./fs-browser.ts";

const file = (text: string) => new File([text], "x");
const entry = (path: string, text = path): PickedFile => ({ path, file: file(text) });

describe("filesDir", () => {
  const dir = filesDir([
    entry("Pack/mods/a.jar"),
    entry("Pack/mods/1.7.10/b.jar"),
    entry("Pack/Config/microblocks.cfg"),
    entry("Pack/options.txt"),
  ]);

  it("roots the tree at the picked folder, named like it", async () => {
    expect(dir.name).toBe("Pack");
    const { dirs, files } = await dir.list();
    expect(dirs.map((d) => d.name).sort()).toEqual(["Config", "mods"]);
    expect(files.map((f) => f.name)).toEqual(["options.txt"]);
  });

  it("finds folders and files whatever their case", async () => {
    expect((await subdir(dir, "CONFIG"))?.name).toBe("Config");
    const config = await subdir(dir, "config");
    expect(config && (await fileIn(config, "MicroBlocks.cfg"))?.name).toBe("microblocks.cfg");
    expect(await subdir(dir, "saves")).toBeNull();
  });

  it("nests folders as deep as the paths do", async () => {
    const mods = await subdir(dir, "mods");
    const nested = mods && (await subdir(mods, "1.7.10"));
    expect((await nested?.list())?.files.map((f) => f.name)).toEqual(["b.jar"]);
  });

  it("accepts backslashes and doubled separators", async () => {
    const odd = filesDir([entry("Pack\\mods\\a.jar"), entry("Pack//mods/b.jar")]);
    const mods = await subdir(odd, "mods");
    expect((await mods?.list())?.files.map((f) => f.name)).toEqual(["a.jar", "b.jar"]);
  });

  it("keeps a flat list, with no common folder, as it is", async () => {
    const flat = filesDir([entry("a.jar"), entry("mods/b.jar")]);
    expect(flat.name).toBe("");
    expect((await flat.list()).files.map((f) => f.name)).toEqual(["a.jar"]);
    expect(await subdir(flat, "mods")).not.toBeNull();
  });

  it("does not take two different top folders for one root", async () => {
    const two = filesDir([entry("A/x.jar"), entry("B/y.jar")]);
    expect(two.name).toBe("");
    expect((await two.list()).dirs.map((d) => d.name)).toEqual(["A", "B"]);
  });

  it("opens a file as ranged reads of its own bytes", async () => {
    const mods = await subdir(dir, "mods");
    const a = mods && (await fileIn(mods, "a.jar"));
    const source = await a?.open();
    expect(source?.size).toBe("Pack/mods/a.jar".length);
    expect(new TextDecoder().decode(await source?.read(5, 9))).toBe("mods");
  });

  it("is empty for no files", async () => {
    expect(await filesDir([]).list()).toEqual({ dirs: [], files: [] });
  });
});

describe("pickedFiles", () => {
  it("takes the path from webkitRelativePath, or the name when a file has none", () => {
    const withPath = new File(["1"], "m.jar");
    Object.defineProperty(withPath, "webkitRelativePath", { value: "Pack/mods/m.jar" });
    const bare = new File(["2"], "n.jar");
    expect(pickedFiles([withPath, bare]).map((p) => p.path)).toEqual(["Pack/mods/m.jar", "n.jar"]);
  });
});

describe("fileSource", () => {
  it("clamps a read to the file", async () => {
    const source = fileSource(new Blob(["hello"]));
    expect(source.size).toBe(5);
    expect(new TextDecoder().decode(await source.read(3, 99))).toBe("lo");
    expect((await source.read(9, 12)).length).toBe(0);
  });
});
