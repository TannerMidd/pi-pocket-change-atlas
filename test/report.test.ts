import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { git, harness, repo } from "./harness.ts";

const story = { title: "T", summary: ["It adds a file."] };

test("no tool is read-only: the scan can fetch from GitHub, and the publish tool writes a file", async () => {
    const atlas = await harness(await repo());

    assert.equal(atlas.tools.size, 2);

    for (const tool of atlas.tools.values()) {
        assert.notEqual(tool.annotations?.readOnlyHint, true, tool.name);
    }
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

const HOSTILE = [
    "</script><script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<!-- <script>",
    '"><svg onload=alert(1)>',
    "\u2028\u2029&amp;",
];

/** The pieces of a report: the JSON, the script, and the page without the two. */
function parts(html: string) {
    const data = /<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(
        html,
    )!;
    const script = /<\/script>\n<script>([\s\S]*?)<\/script>\n<\/body>/.exec(html)!;

    return {
        data: data[1]!,
        script: script[1]!,
        page: html.replace(data[0], "").replace(script[0], ""),
    };
}

test("text from the repository and from Pi cannot add markup to the report", async () => {
    const dir = await repo();
    const atlas = await harness(dir);
    const evil = HOSTILE.join(" ");

    git(dir, "checkout", "-q", "-b", "feat");
    await mkdir(join(dir, "x<"), { recursive: true });
    await writeFile(join(dir, "x<", `y>${evil.replaceAll("/", "_")}`), `${evil}\n`);
    await writeFile(join(dir, "a.txt"), `${evil}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", evil);

    const made = await atlas.call("change_atlas_publish", {
        base: "main",
        head: "HEAD",
        target: "feat",
        title: evil,
        summary: [evil],
        intent: evil,
        areas: [{ name: evil, kind: evil, summary: evil, files: [evil] }],
        architecture: {
            summary: evil,
            layers: [evil],
            components: [{ id: evil, name: evil, layer: evil, status: evil, summary: evil }],
            links: [{ from: evil, to: evil, status: evil, label: evil }],
        },
        walkthrough: [{ title: evil, text: evil, files: [evil] }],
        fileNotes: [{ path: evil, note: evil }],
        risks: [{ level: evil, text: evil, files: [evil] }],
        checks: [{ text: evil, status: evil }],
    });
    const path = /Wrote the Change Atlas: (\S+\.html)/.exec(made)![1]!;
    const html = await readFile(path, "utf8");
    const { data, script, page } = parts(html);

    // Only the page's own two scripts exist. The title is escaped.
    assert.equal(html.match(/<script/gi)!.length, 2);
    assert.equal(html.match(/<\/script/gi)!.length, 2);
    assert.doesNotMatch(page, /<img|<svg|<iframe/);
    assert.match(page, /<title>&#60;\/script&#62;/);

    // The JSON cannot end its script, and it still holds every string exactly.
    assert.doesNotMatch(data, /[<>&\u2028\u2029]/);

    const parsed = JSON.parse(data) as {
        story: { title: string; summary: string[] };
        commits: { subject: string }[];
        files: { path: string }[];
    };

    assert.equal(parsed.story.title, evil);
    assert.equal(parsed.commits[0]!.subject, evil);
    assert.ok(parsed.files.some((file) => file.path.startsWith("x</")));

    // The page's own script has no text from outside, and the policy names exactly that script.
    assert.doesNotMatch(script, /<\/script/i);

    const hash = createHash("sha256").update(script).digest("base64");
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)![1]!;

    assert.match(policy, /^default-src 'none'; /);
    assert.ok(policy.includes(`script-src 'sha256-${hash}'`));
    assert.doesNotMatch(policy, /unsafe-eval|https?:|\*/);
    assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
});

test("the report script loads and sends nothing over the network", async () => {
    const script = await readFile(
        join(import.meta.dirname, "..", "change-atlas", "report.js"),
        "utf8",
    );
    const css = await readFile(
        join(import.meta.dirname, "..", "change-atlas", "report.css"),
        "utf8",
    );

    assert.doesNotMatch(
        script,
        /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|importScripts|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc|localStorage|sessionStorage|document\.cookie/,
    );
    assert.doesNotMatch(css, /url\(|@import|https?:/);
});
