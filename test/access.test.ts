import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harness, repo, temp } from "./harness.ts";

const outside = /maps only the repository of the session folder/;

test("a repository next to the session folder is refused, by path, by ../, and by ~", async () => {
    const parent = await temp("two");
    const mine = await repo(parent, "mine");
    const other = await repo(parent, "other");
    const atlas = await harness(mine);

    await writeFile(join(other, "a.txt"), "SECRET-IN-OTHER\nhello\n");

    for (const folder of [other, "../other", join(mine, "..", "other"), "/", "/tmp"]) {
        await atlas.fails("change_atlas_scan", { repo: folder }, /./);
    }

    await atlas.fails("change_atlas_scan", { repo: other }, outside);
    await atlas.fails("change_atlas_scan", { repo: "../other" }, outside);
    await atlas.fails(
        "change_atlas_publish",
        { repo: other, base: "HEAD", head: "WORKTREE", title: "T", summary: ["It reads."] },
        outside,
    );
});

test("a link inside the session folder to a repository outside it is refused", async () => {
    const parent = await temp("link");
    const session = join(parent, "session");
    const other = await repo(parent, "other");
    await mkdir(session, { recursive: true });
    await symlink(other, join(session, "door"));

    const inside = await harness(session);

    await inside.fails("change_atlas_scan", { repo: "door" }, outside);
    await inside.fails("change_atlas_scan", { repo: join(session, "door") }, outside);
});

test("the repository of the session folder, and a repository inside it, work", async () => {
    const parent = await temp("ok");
    const mine = await repo(parent, "mine");
    const inner = await repo(mine, "inner");

    await writeFile(join(inner, "a.txt"), "hello\nmore\n");

    // The session folder is a folder of the repository: the repository above it is the one to map.
    await mkdir(join(mine, "sub"));

    const fromSub = await harness(join(mine, "sub"));

    assert.match(await fromSub.call("change_atlas_scan", {}), /No changes|a\.txt/);

    // The session folder holds the repository.
    const fromParent = await harness(parent);

    assert.match(await fromParent.call("change_atlas_scan", { repo: "mine/inner" }), /a\.txt/);
    assert.match(
        await fromParent.call("change_atlas_scan", { repo: join(parent, "mine") }),
        /No changes|inner/,
    );
});
