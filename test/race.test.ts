import assert from "node:assert/strict";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { regularFile } from "../change-atlas.ts";
import { repo, temp } from "./harness.ts";

/** A repository with sub/package.json, a folder outside with the same name of file, and the first call's setup. */
async function setup() {
    const dir = await repo();
    const outside = await temp("outside");

    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "package.json"), "INSIDE");
    await writeFile(join(outside, "package.json"), "OUTSIDE-SECRET");

    return { dir, outside };
}

test("a file is read when nothing changes", async () => {
    const { dir } = await setup();
    const file = await regularFile(dir, "sub/package.json", 1000);

    assert.equal(file?.buffer?.toString(), "INSIDE");
});

test("a folder that becomes a link between the check and the open does not give an outside file", async () => {
    const { dir, outside } = await setup();
    const file = await regularFile(dir, "sub/package.json", 1000, async () => {
        await rename(join(dir, "sub"), join(dir, "sub-away"));
        await symlink(outside, join(dir, "sub"));
    });

    assert.equal(file, undefined);
});

test("a folder above the checked one that becomes a link does not either", async () => {
    const { dir, outside } = await setup();

    await mkdir(join(dir, "deep"));
    await rename(join(dir, "sub"), join(dir, "deep", "sub"));

    const file = await regularFile(dir, "deep/sub/package.json", 1000, async () => {
        await rename(join(dir, "deep"), join(dir, "deep-away"));
        await mkdir(join(dir, "deep"));
        await symlink(outside, join(dir, "deep", "sub"));
    });

    assert.equal(file, undefined);
});

test("the file itself that becomes a link between the check and the open is refused", async () => {
    const { dir, outside } = await setup();
    const file = await regularFile(dir, "sub/package.json", 1000, async () => {
        await rm(join(dir, "sub", "package.json"));
        await symlink(join(outside, "package.json"), join(dir, "sub", "package.json"));
    });

    assert.equal(file, undefined);
});
