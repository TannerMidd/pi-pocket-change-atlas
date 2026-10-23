import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { git, harness, repo } from "./harness.ts";

const story = { title: "T", summary: ["It adds a file."] };

test("only the scan tool is read-only: the publish tool writes a file", async () => {
    const atlas = await harness(await repo());

    assert.equal(atlas.tools.get("change_atlas_scan")!.annotations?.readOnlyHint, true);
    assert.notEqual(atlas.tools.get("change_atlas_publish")!.annotations?.readOnlyHint, true);
});

test("a report goes to change-atlas/ in the data folder, readable by its owner only", async () => {
    const dir = await repo();
    const atlas = await harness(dir);
    const made = await atlas.call("change_atlas_publish", {
        base: "HEAD",
        head: "WORKTREE",
        target: "../../../etc/passwd; x",
        ...story,
    });
    const path = /Wrote the Change Atlas: (\S+\.html)/.exec(made)![1]!;

    assert.equal(dirname(path), join(atlas.dataDir, "change-atlas"));
    assert.match(basename(path), /^[a-z0-9-]+\.html$/);
    assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal((await stat(dirname(path))).mode & 0o077, 0);
    assert.deepEqual(await readdir(dirname(path)), [basename(path)]);
    assert.match(await readFile(path, "utf8"), /^<!doctype html>/);
});

test("the file name comes from a few safe characters, whatever the branch is called", async () => {
    const dir = await repo();
    const atlas = await harness(dir);

    git(dir, "checkout", "-q", "-b", "a$(touch${IFS}pwn)`x`;&|<>'\"é/b");

    const made = await atlas.call("change_atlas_publish", {
        base: "HEAD",
        head: "WORKTREE",
        ...story,
    });
    const path = /Wrote the Change Atlas: (\S+\.html)/.exec(made)![1]!;

    assert.match(basename(path), /^[a-z0-9-]+\.html$/);
    assert.equal(dirname(path), join(atlas.dataDir, "change-atlas"));
});
