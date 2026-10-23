import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harness, repo, temp } from "./harness.ts";

test("a new symbolic link is not followed, so a file outside the repository stays out", async () => {
    const dir = await repo();
    const outside = join(await temp("secret"), "token");
    const atlas = await harness(dir);

    await writeFile(outside, "TOP-SECRET-VALUE\n");
    await symlink(outside, join(dir, "link.txt"));
    await writeFile(join(dir, "plain.txt"), "plain text\n");

    const scan = await atlas.call("change_atlas_scan", {});

    assert.match(scan, /plain\.txt/);
    assert.doesNotMatch(scan, /TOP-SECRET-VALUE/);

    const made = await atlas.call("change_atlas_publish", {
        base: "HEAD",
        head: "WORKTREE",
        title: "A link",
        summary: ["It adds a file."],
    });
    const path = /Wrote the Change Atlas: (\S+)/.exec(made)![1]!;
    const html = await readFile(path, "utf8");

    assert.match(html, /plain text/);
    assert.doesNotMatch(html, /TOP-SECRET-VALUE/);
    assert.doesNotMatch(html, /link\.txt/);
});

test("a named pipe in the working tree does not stop the scan", async () => {
    const dir = await repo();
    const atlas = await harness(dir);

    execFileSync("mkfifo", [join(dir, "pipe")]);
    await writeFile(join(dir, "plain.txt"), "plain text\n");
    assert.match(await atlas.call("change_atlas_scan", {}), /plain\.txt/);
});

test("a package.json that is a link adds no dependency changes from outside", async () => {
    const dir = await repo();
    const outside = join(await temp("manifest"), "package.json");
    const atlas = await harness(dir);

    await writeFile(outside, JSON.stringify({ dependencies: { leaked: "1.0.0" } }));
    await symlink(outside, join(dir, "package.json"));
    assert.doesNotMatch(await atlas.call("change_atlas_scan", {}), /leaked/);
    assert.deepEqual((await readdir(dir)).includes("package.json"), true);
});
