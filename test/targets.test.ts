import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGh, git, harness, repo, temp } from "./harness.ts";

test("it names two tools and one owner page, and adds no route", async () => {
    const dir = await repo();
    const atlas = await harness(dir);

    assert.equal(atlas.extension.name, "change-atlas");
    assert.deepEqual([...atlas.tools.keys()].sort(), ["change_atlas_publish", "change_atlas_scan"]);
    assert.deepEqual(atlas.clients, [["change-atlas", { access: "owner" }]]);
    assert.deepEqual(atlas.routes, []);
});

test("it maps local changes, a commit, and a range", async () => {
    const dir = await repo();
    const atlas = await harness(dir);

    await writeFile(join(dir, "a.txt"), "hello\nworld\n");
    await writeFile(join(dir, "new.txt"), "fresh\n");

    const local = await atlas.call("change_atlas_scan", {});

    assert.match(local, /Local changes on main/);
    assert.match(local, /M \+1 −0 Q\[a\.txt\]/);
    assert.match(local, /A \+1 −0 Q\[new\.txt\]/);

    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");

    assert.match(await atlas.call("change_atlas_scan", { target: "HEAD" }), /Commit HEAD/);
    assert.match(await atlas.call("change_atlas_scan", { target: "HEAD~1..HEAD" }), /new\.txt/);
    assert.match(await atlas.call("change_atlas_scan", { target: "HEAD~1...HEAD" }), /new\.txt/);
    assert.match(
        await atlas.call("change_atlas_scan", { target: "local" }),
        /No changes in Q\[Local/,
    );
});

test("a ref that starts with - never reaches Git as an option", async () => {
    const dir = await repo();
    const out = join(await temp("out"), "pwn");
    const atlas = await harness(dir);
    const hostile = [
        `--output=${out}`,
        `--output=${out}..HEAD`,
        `HEAD..--output=${out}`,
        `--output=${out}...HEAD`,
        "-p",
        "--help",
        "-1",
    ];

    for (const target of hostile) {
        await atlas.fails("change_atlas_scan", { target }, /must not start with "-"/);
    }

    // The publish tool takes base and head from the model too.
    for (const [base, head] of [
        [`--output=${out}`, "HEAD"],
        ["HEAD", `--output=${out}`],
        ["HEAD", "-p"],
    ]) {
        await atlas.fails(
            "change_atlas_publish",
            { base, head, title: "T", summary: ["It changes."] },
            /must not start with "-"/,
        );
    }

    await assert.rejects(access(out));
});

test("an unknown ref is an error, not a crash", async () => {
    const atlas = await harness(await repo());

    await atlas.fails("change_atlas_scan", { target: "no-such-branch" }, /does not know the ref/);
    await atlas.fails("change_atlas_scan", { target: "x..y" }, /does not know the ref/);
});

test("a folder that is no repository is an error", async () => {
    const atlas = await harness(await temp("plain"));

    await atlas.fails("change_atlas_scan", {}, /not in a git repository/);
});

test("a PR number or URL goes to gh as separate arguments, and only a clean URL", async () => {
    const dir = await repo();
    const first = git(dir, "rev-parse", "HEAD");

    await writeFile(join(dir, "b.txt"), "b\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");

    const head = git(dir, "rev-parse", "HEAD");
    const gh = await fakeGh({
        number: 12,
        title: "A title",
        body: "A body",
        url: "https://github.com/acme/widgets/pull/12",
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: head,
        baseRefOid: first,
        author: { login: "ada" },
    });
    const atlas = await harness(dir);

    // The two commits are in the clone already, so nothing is fetched.
    assert.match(
        await atlas.call("change_atlas_scan", { target: "#12" }),
        /PR #12 · feature → main/,
    );
    assert.match(await atlas.call("change_atlas_scan", { target: "PR 12" }), /PR #12/);
    assert.match(
        await atlas.call("change_atlas_scan", {
            target: "https://github.com/acme/widgets/pull/12/files?x=1",
        }),
        /PR #12/,
    );

    const calls = (await gh.calls()).trim().split("\n");

    assert.equal(calls.length, 3);
    assert.match(calls[0]!, /^pr view 12 --json /);
    assert.match(calls[2]!, /^pr view 12 --repo acme\/widgets --json /);

    // These are not pull request URLs: gh must not run for them.
    const before = (await gh.calls()).length;

    for (const target of [
        "https://github.com/../x/pull/1",
        "https://github.com/-x/y/pull/1",
        "https://github.com/a/b/pull/1x",
        "http://github.com/a/b/pull/1",
        "https://github.com.evil.example/a/b/pull/1",
        "12; rm -rf /",
        "--repo=x",
    ]) {
        await assert.rejects(atlas.call("change_atlas_scan", { target }), Error, target);
    }

    assert.equal((await gh.calls()).length, before);
    await gh.remove();
});

test("the base branch of a PR cannot become a fetch option", async () => {
    const parent = await temp("pr");
    const dir = await repo(parent, "clone");
    const mark = join(parent, "PWN");
    const head = git(dir, "rev-parse", "HEAD");
    const gh = await fakeGh({
        number: 7,
        title: "T",
        body: "",
        url: "https://github.com/acme/widgets/pull/7",
        baseRefName: `--upload-pack=touch ${mark}`,
        headRefName: "feature",
        headRefOid: head,
        // A commit that this clone does not have, so the tool fetches the base branch.
        baseRefOid: "0123456789abcdef0123456789abcdef01234567",
        author: { login: "ada" },
    });
    const origin = await repo(parent, "origin");

    git(dir, "remote", "add", "origin", origin);

    const atlas = await harness(dir);

    await assert.rejects(atlas.call("change_atlas_scan", { target: "7" }));
    await assert.rejects(access(mark));
    assert.match(await readFile(join(dir, ".git", "config"), "utf8"), /origin/);
    await gh.remove();
});
