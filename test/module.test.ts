import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

/** The first paragraph of the module's comment: the gallery's description. */
async function description() {
    const source = await readFile(join(root, "change-atlas.ts"), "utf8");
    const comment = source.slice(source.indexOf("/**") + 3, source.indexOf("*/"));

    return comment
        .split(/\n\s*\*\s*\n/)[0]!
        .replace(/^\s*\* ?/gm, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
}

test("the description says what the module reads, writes, and sends", async () => {
    const text = await description();

    assert.ok(text.length <= 600, `${text.length} characters`);
    assert.match(text, /\breads\b/);
    assert.match(text, /\bwrites\b/);
    assert.match(text, /\bgo(es)? to\b/);
    assert.match(text, /GitHub/);
    assert.match(text, /model provider/);
    assert.doesNotMatch(text, /sends nothing elsewhere/);
});

test("the module imports only its own files, Node, and Pi Pocket's packages", async () => {
    const source = await readFile(join(root, "change-atlas.ts"), "utf8");
    const imports = [...source.matchAll(/^import (?:type )?[^;]*? from "([^"]+)";/gm)].map(
        (match) => match[1]!,
    );

    assert.ok(imports.length > 0);

    for (const name of imports) {
        assert.match(
            name,
            /^(node:[a-z_/]+|@earendil-works\/pi-(ai|durable)|\.\/_pocket\.d\.ts)$/,
            name,
        );
    }

    assert.doesNotMatch(
        source,
        /\b(eval|new Function|vm\.run\w+)\s*\(|child_process["']\)|(?<![.\w])exec(Sync)?\(|shell:\s*true/,
    );
    assert.doesNotMatch(source, /https?:\/\/(?!github\.com[/.])/);
    assert.doesNotMatch(
        source,
        /\bfetch\(|fetchPublic|XMLHttpRequest|WebSocket|TODO|FIXME|console\./,
    );
});

test("the files are plain text with no hidden file, and a name that the gallery accepts", async () => {
    const names = (await readdir(join(root, "change-atlas"))).sort();

    assert.deepEqual(names, ["index.js", "report.css", "report.js"]);

    for (const name of names) {
        const text = await readFile(join(root, "change-atlas", name), "utf8");

        assert.doesNotMatch(text, /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/, name);
        assert.ok(Buffer.byteLength(text) < 512 * 1024, name);
    }
});
