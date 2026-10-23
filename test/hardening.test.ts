import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGh, fakeGit, git, harness, repo, temp } from "./harness.ts";

/** A script that records that it ran. */
async function marker() {
    const dir = await temp("marker");
    const script = join(dir, "run.sh");
    const mark = join(dir, "ran");

    await writeFile(script, `#!/bin/sh\necho "$0 $*" >> '${mark}'\nexit 0\n`);
    await chmod(script, 0o755);

    return { script, ran: () => readFile(mark, "utf8").catch(() => "") };
}

test("a program that a repository's config names is never run: core.fsmonitor, diff.external, a hook, a pager", async () => {
    const dir = await repo();
    const run = await marker();

    git(dir, "config", "core.fsmonitor", run.script);
    git(dir, "config", "diff.external", run.script);
    git(dir, "config", "core.hooksPath", join(dir, "hooks"));
    git(dir, "config", "core.pager", run.script);
    git(dir, "config", "core.sshCommand", run.script);
    await mkdir(join(dir, "hooks"));
    await writeFile(
        join(dir, "hooks", "reference-transaction"),
        `#!/bin/sh\n'${run.script}' hook\n`,
    );
    await chmod(join(dir, "hooks", "reference-transaction"), 0o755);
    await writeFile(join(dir, "a.txt"), "hello\nmore\n");
    await writeFile(join(dir, "new.txt"), "new\n");

    const atlas = await harness(dir);

    assert.match(await atlas.call("change_atlas_scan", {}), /a\.txt/);
    await atlas.call("change_atlas_publish", {
        base: "HEAD",
        head: "WORKTREE",
        title: "T",
        summary: ["It changes a file."],
    });
    assert.equal(await run.ran(), "");
});

test("a program in the environment is not run either: GIT_EXTERNAL_DIFF, GIT_PAGER", async () => {
    const dir = await repo();
    const run = await marker();
    const atlas = await harness(dir);
    const before = { ...process.env };

    process.env.GIT_EXTERNAL_DIFF = run.script;
    process.env.GIT_PAGER = run.script;
    process.env.GIT_SSH_COMMAND = run.script;

    try {
        await writeFile(join(dir, "a.txt"), "hello\nmore\n");
        assert.match(await atlas.call("change_atlas_scan", {}), /a\.txt/);
    } finally {
        for (const key of ["GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_SSH_COMMAND"]) {
            if (before[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = before[key];
            }
        }
    }

    assert.equal(await run.ran(), "");
});

const PR = {
    number: 7,
    title: "T",
    body: "",
    url: "https://github.com/acme/widgets/pull/7",
    baseRefName: "main",
    headRefName: "feature",
    author: { login: "ada" },
};

/** A clone at its first commit, and its upstream, which also has a second commit as the PR's head. */
async function upstream() {
    const parent = await temp("pr");
    const source = await repo(parent, "upstream");
    const first = git(source, "rev-parse", "HEAD");

    git(source, "clone", "-q", source, join(parent, "clone"));
    git(join(parent, "clone"), "config", "user.email", "test@example.com");
    git(join(parent, "clone"), "config", "user.name", "Test");
    await writeFile(join(source, "b.txt"), "b\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "second");

    const head = git(source, "rev-parse", "HEAD");

    git(source, "update-ref", "refs/pull/7/head", head);

    return { parent, source, clone: join(parent, "clone"), first, head };
}

test("a PR is fetched from the address that GitHub names, never from origin", async () => {
    const { parent, clone, first, head } = await upstream();
    const run = await marker();
    const gh = await fakeGh({ ...PR, headRefOid: head, baseRefOid: first });
    const wrapper = await fakeGit();

    // origin is a program, not an address.
    git(clone, "remote", "set-url", "origin", `ext::sh -c "'${run.script}' ext"`);

    const atlas = await harness(clone);

    await assert.rejects(atlas.call("change_atlas_scan", { target: "7" }));

    const fetches = (await wrapper.fetches()).trim().split("\n");

    assert.equal(fetches.length, 1);
    assert.match(fetches[0]!, /https:\/\/github\.com\/acme\/widgets\.git pull\/7\/head$/);
    assert.doesNotMatch(fetches[0]!, /origin|ext::/);
    assert.equal(await run.ran(), "");
    await assert.rejects(access(join(parent, "clone", ".git", "FETCH_HEAD")));
    await gh.remove();
    await wrapper.remove();
});

test("a PR that is not on github.com, or has a strange commit id, is refused before any fetch", async () => {
    const { clone, first, head } = await upstream();
    const wrapper = await fakeGit();

    for (const odd of [
        { url: "https://evil.example/acme/widgets/pull/7" },
        { url: "http://github.com/acme/widgets/pull/7" },
        { url: "https://github.com/../widgets/pull/7" },
        { url: "https://github.com/acme/widgets/pull/7/../../x" },
        { headRefOid: "--upload-pack=x" },
        { baseRefOid: "main" },
    ]) {
        const gh = await fakeGh({ ...PR, headRefOid: head, baseRefOid: first, ...odd });
        const atlas = await harness(clone);

        await assert.rejects(atlas.call("change_atlas_scan", { target: "7" }), /cannot read/);
        await gh.remove();
    }

    assert.equal(await wrapper.fetches(), "");
    await wrapper.remove();
});

test("fetched PR objects go to a cache in the data folder: the repository is not changed", async () => {
    const { parent, source, clone, first, head } = await upstream();
    const gh = await fakeGh({ ...PR, headRefOid: head, baseRefOid: first });
    const wrapper = await fakeGit(source);
    const atlas = await harness(clone);
    const refs = git(clone, "for-each-ref");
    const scan = await atlas.call("change_atlas_scan", { target: "7" });

    assert.match(scan, /PR #7 · feature → main/);
    assert.match(scan, /b\.txt/);
    assert.match(
        await wrapper.fetches(),
        /^fetch .*https:\/\/github\.com\/acme\/widgets\.git pull\/7\/head$/m,
    );

    // Nothing in the repository's .git changed: no FETCH_HEAD, no new ref, and not the new commit.
    await assert.rejects(access(join(clone, ".git", "FETCH_HEAD")));
    assert.equal(git(clone, "for-each-ref"), refs);
    assert.throws(() => git(clone, "cat-file", "-e", head));

    // The same PR again, and publish with only the two commit ids, find the objects in the cache.
    assert.match(await atlas.call("change_atlas_scan", { target: "7" }), /b\.txt/);
    assert.match(
        await atlas.call("change_atlas_publish", {
            base: first,
            head,
            title: "T",
            summary: ["It adds a file."],
        }),
        /Wrote the Change Atlas/,
    );
    assert.ok(parent);
    await gh.remove();
    await wrapper.remove();
});
