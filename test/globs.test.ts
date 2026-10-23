import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { harness, repo } from "./harness.ts";

const FILES = ["src/a/x.ts", "src/b.ts", "src/a/deep/y.ts", "docs/readme.md", "root.txt", "a.b"];

/** The files that no area pattern fits: the publish tool lists them. */
async function loose(patterns: string[]) {
    const dir = await repo();
    const atlas = await harness(dir);

    for (const file of FILES) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), "one\n");
    }

    const made = await atlas.call("change_atlas_publish", {
        base: "HEAD",
        head: "WORKTREE",
        title: "T",
        summary: ["It adds files."],
        areas: [{ name: "A", summary: "It adds files.", files: patterns }],
    });
    const line = /files fit no area and show as "Other changes": (.*)/.exec(made)?.[1];

    return line ? [...line.matchAll(/Q\[([^\]]*)\]/g)].map((match) => match[1]!).sort() : [];
}

const without = (...gone: string[]) => FILES.filter((file) => !gone.includes(file)).sort();

test("area patterns: a path, a folder, and globs", async () => {
    assert.deepEqual(await loose(["src/a/x.ts"]), without("src/a/x.ts"));
    assert.deepEqual(await loose(["src/a/"]), without("src/a/x.ts", "src/a/deep/y.ts"));
    assert.deepEqual(await loose(["src/a"]), without("src/a/x.ts", "src/a/deep/y.ts"));
    assert.deepEqual(await loose(["src/*.ts"]), without("src/b.ts"));
    assert.deepEqual(await loose(["src/*/x.ts"]), without("src/a/x.ts"));
    // As before, "**/" needs a slash: src/b.ts is not below a folder of src/.
    assert.deepEqual(await loose(["src/**/*.ts"]), without("src/a/x.ts", "src/a/deep/y.ts"));
    assert.deepEqual(await loose(["**/*.md"]), without("docs/readme.md"));
    assert.deepEqual(await loose(["docs/*"]), without("docs/readme.md"));
    assert.deepEqual(await loose(["a.b"]), without("a.b"));
    assert.deepEqual(await loose(["a.*"]), without("a.b"));
    assert.deepEqual(await loose(["aXb"]), [...FILES].sort());
    assert.deepEqual(await loose(["*"]), without("root.txt", "a.b"));
});

test("a pattern with many ** cannot stall the server", async () => {
    const started = Date.now();

    assert.deepEqual(
        await loose(["**a".repeat(25) + "b", "*".repeat(5000), "a/".repeat(300) + "**x"]),
        [...FILES].sort(),
    );
    assert.ok(Date.now() - started < 5000, "it answers at once");
});
