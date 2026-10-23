import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harness, repo, temp } from "./harness.ts";

test("repo can name a repository next to the session folder, by path, by ../, and by a link", async () => {
    const parent = await temp("two");
    const mine = await repo(parent, "mine");
    const other = await repo(parent, "other");
    const atlas = await harness(mine);

    await writeFile(join(other, "a.txt"), "hello\nchanged in other\n");
    await symlink(other, join(mine, "door"));

    for (const folder of [other, "../other", join(mine, "..", "other"), "door"]) {
        const scan = await atlas.call("change_atlas_scan", { repo: folder });

        assert.match(scan, /Q\[other\]|a\.txt/, folder);
        assert.match(scan, /M \+1 −0 Q\[a\.txt\]/, folder);
    }

    const made = await atlas.call("change_atlas_publish", {
        repo: other,
        base: "HEAD",
        head: "WORKTREE",
        title: "T",
        summary: ["It changes a file."],
    });

    assert.match(made, /Wrote the Change Atlas/);
});

test("the session's repository, from a folder of it or from above it, works", async () => {
    const parent = await temp("ok");
    const mine = await repo(parent, "mine");
    const inner = await repo(mine, "inner");

    await writeFile(join(inner, "a.txt"), "hello\nmore\n");
    await mkdir(join(mine, "sub"));

    const fromSub = await harness(join(mine, "sub"));

    assert.match(await fromSub.call("change_atlas_scan", {}), /No changes|a\.txt/);

    const fromParent = await harness(parent);

    assert.match(await fromParent.call("change_atlas_scan", { repo: "mine/inner" }), /a\.txt/);
    assert.match(
        await fromParent.call("change_atlas_scan", { repo: join(parent, "mine") }),
        /No changes|inner/,
    );
});
