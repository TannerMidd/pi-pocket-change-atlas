import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

type Entry = {
    name: string;
    description: string;
    source: { repo: string; commit: string; path: string };
    files: { name: string; sha256: string; size: number }[];
    pocketApi: number;
    declares: Record<string, unknown>;
};

const entry = JSON.parse(await readFile(join(root, "docs", "gallery-entry.json"), "utf8")) as Entry;

test("the gallery entry lists every file with its size and SHA-256 hash", async () => {
    assert.equal(entry.name, "change-atlas");
    assert.deepEqual(
        entry.files.map((file) => file.name),
        [
            "change-atlas.ts",
            "change-atlas/index.js",
            "change-atlas/report.css",
            "change-atlas/report.js",
        ],
    );

    for (const file of entry.files) {
        const bytes = await readFile(join(root, file.name));

        assert.equal(file.size, bytes.length, `${file.name}: size`);
        assert.equal(
            file.sha256,
            createHash("sha256").update(bytes).digest("hex"),
            `${file.name}: hash`,
        );
    }
});

test("the gallery entry agrees with the module", async () => {
    const source = await readFile(join(root, "change-atlas.ts"), "utf8");
    const comment = source.slice(source.indexOf("/**") + 3, source.indexOf("*/"));
    const description = comment
        .split(/\n\s*\*\s*\n/)[0]!
        .replace(/^\s*\* ?/gm, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();

    assert.equal(entry.description, description);
    assert.equal(entry.pocketApi, Number(/export const pocketApi = (\d+);/.exec(source)![1]));
    assert.deepEqual(entry.declares.tools, ["change_atlas_scan", "change_atlas_publish"]);
    assert.deepEqual(entry.declares.readOnlyTools, []);
    assert.equal(entry.declares.client, "owner");
    assert.equal(entry.declares.access, "owner");
    assert.deepEqual(entry.declares.routes, []);
    assert.deepEqual(entry.declares.hooks, []);
    assert.deepEqual(entry.declares.wraps, ["tool artifact_inline"]);
    assert.deepEqual(entry.declares.commands, ["global change-atlas-display"]);
    assert.equal(entry.source.repo, "TannerMidd/pi-pocket-change-atlas");
    assert.match(entry.source.commit, /^([0-9a-f]{40}|TO_FILL)$/);
});
