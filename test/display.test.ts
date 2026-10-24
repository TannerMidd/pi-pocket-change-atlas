import assert from "node:assert/strict";
import { link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harness, repo, temp } from "./harness.ts";

const story = { base: "HEAD", head: "WORKTREE", title: "A change", summary: ["It adds a file."] };

async function changed() {
    const dir = await repo();

    await writeFile(join(dir, "b.txt"), "new\n");

    return dir;
}

test("by default a report goes inline, as a card, through artifact_inline with its path", async () => {
    const atlas = await harness(await changed());
    const made = await atlas.call("change_atlas_publish", story);

    assert.match(made, /call artifact_inline directly \(not inside codemode/);
    assert.match(made, /with path "[^"]+\.html"/);
    assert.doesNotMatch(made, /call artifact with path/);
});

test("a session without an artifact_inline that takes a path gets the viewer, and says why", async () => {
    // PiP has no artifact_inline; without this module's wrap, it takes no path.
    for (const tools of [[], [{ name: "artifact_inline", parameters: { properties: {} } }]]) {
        const atlas = await harness(await changed(), { tools });
        const made = await atlas.call("change_atlas_publish", story);

        assert.match(made, /call artifact with path/);
        assert.match(made, /no artifact_inline that takes a path/);
    }
});

test("/change-atlas-display saves the owner's choice, and a call can still pick one", async () => {
    const atlas = await harness(await changed());
    const command = atlas.commands.get("change-atlas-display")!;

    assert.equal(command.scope, "global", "the owner's alone");
    assert.match((await command.handler("", {})).message!, /inline/);
    assert.match((await command.handler(" Viewer ", {})).message!, /artifact viewer/);
    assert.match((await command.handler("", {})).message!, /artifact viewer/);

    const file = join(atlas.dataDir, "change-atlas", "settings.json");

    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { display: "viewer" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const viewer = await atlas.call("change_atlas_publish", story);

    assert.match(viewer, /call artifact with path/);
    assert.doesNotMatch(viewer, /no artifact_inline/, "the owner chose it: no excuse needed");

    const inline = await atlas.call("change_atlas_publish", { ...story, display: "inline" });

    assert.match(inline, /call artifact_inline directly/);
    await assert.rejects(command.handler("card", {}), /Give inline or viewer/);
    await command.handler("inline", {});
    assert.match(await atlas.call("change_atlas_publish", story), /call artifact_inline/);
});

test("a preview with no scripts shows a static summary of the report, and a note to press Run", async () => {
    const atlas = await harness(await changed());
    const made = await atlas.call("change_atlas_publish", {
        ...story,
        title: "A <b>change</b>",
        intent: "It is necessary.",
        areas: [{ name: "Core", kind: "feature", summary: "It adds b.", files: ["b.txt"] }],
        risks: [{ level: "high", text: "Check b." }],
    });
    const html = await readFile(/Wrote the Change Atlas: (\S+)/.exec(made)![1]!, "utf8");
    const app = html.slice(
        html.indexOf('<div id="app">'),
        html.indexOf('<script type="application/json"'),
    );

    assert.match(app, /<h1>A &#60;b&#62;change&#60;\/b&#62;<\/h1>/, "escaped");
    assert.match(app, /<li>It adds a file\.<\/li>/);
    assert.match(app, /<b>Why<\/b>It is necessary\./);
    assert.match(app, /<b>Core<\/b>/);
    assert.match(app, /class="lvl high">high/);
    assert.match(app, /st-added">A<\/span><span class="add">\+1<\/span>.*b\.txt/);
    assert.match(app, /<noscript><p class="run-note">[^<]*Press Run/);
    assert.doesNotMatch(app, /<script/);
});

/** A stand-in for Pi Pocket 0.21.0's artifact_inline: content or edits, no path. It echoes what it got. */
function builtIn() {
    const seen: Record<string, unknown>[] = [];
    const tool = {
        name: "artifact_inline",
        description: "Show an HTML page as a card.",
        parameters: {
            type: "object",
            required: ["id", "title"],
            properties: { id: {}, title: {}, content: {}, edits: {} },
        },
        replay: "safe",
        // As Pi Pocket's: a call that published already (`api.published`, a replay) finds its version with no
        // content; any other call needs content or edits.
        execute: async (args: Record<string, unknown>, api: { published?: boolean }) => {
            if (!api.published && args.content === undefined && args.edits === undefined) {
                throw new Error("Give exactly one of content or nonempty edits.");
            }

            seen.push(args);

            return { output: [{ type: "text", text: "Published" }], details: { inline: true } };
        },
    };

    return { tool, seen };
}

type Wrapped = {
    name: string;
    description: string;
    parameters: { required: string[]; properties: Record<string, unknown> };
    execute(args: object, api: object, context: object): Promise<unknown>;
};

async function wrapped(dataDir: string) {
    const atlas = await harness(await changed(), { dataDir });
    const wrap = (
        atlas.extension as unknown as { wraps: { tool: string; wrap(t: object): Wrapped }[] }
    ).wraps[0]!;
    const { tool, seen } = builtIn();

    assert.equal(wrap.tool, "artifact_inline");

    return { atlas, tool: wrap.wrap(tool), seen };
}

test("the wrap lets artifact_inline take a report's path, and passes the page on as content", async () => {
    const { atlas, tool, seen } = await wrapped(await temp("data"));
    const made = await atlas.call("change_atlas_publish", story);
    const path = /Wrote the Change Atlas: (\S+)/.exec(made)![1]!;

    assert.equal(tool.name, "artifact_inline", "the same tool, so the app draws its card");
    assert.ok("path" in tool.parameters.properties);
    assert.deepEqual(tool.parameters.required, ["id", "title"], "path stays optional");
    assert.match(tool.description, /Change Atlas report/);

    await tool.execute({ id: "atlas", title: "Atlas", path }, {}, {});
    assert.deepEqual(Object.keys(seen[0]!).sort(), ["content", "id", "title"]);
    assert.equal(seen[0]!.content, await readFile(path, "utf8"));

    // Every other call goes through as it came.
    await tool.execute({ id: "x", title: "X", content: "<p>hi</p>" }, {}, {});
    assert.deepEqual(seen[1], { id: "x", title: "X", content: "<p>hi</p>" });
    await assert.rejects(
        tool.execute({ id: "x", title: "X", content: "<p>", path }, {}, {}),
        /exactly one of/,
    );
});

test("the wrap reads only the module's own reports, never another file", async () => {
    const dataDir = await temp("data");
    const { atlas, tool } = await wrapped(dataDir);
    const folder = join(dataDir, "change-atlas");

    await atlas.call("change_atlas_publish", story);
    const outside = join(await temp("secret"), "page.html");

    await writeFile(outside, "<p>SECRET</p>");
    await writeFile(join(folder, "notes.txt"), "SECRET");
    await symlink(outside, join(folder, "link.html"));
    await mkdir(join(folder, "git", "x"), { recursive: true });
    await writeFile(join(folder, "git", "x", "a.html"), "<p>SECRET</p>");

    for (const path of [
        outside,
        join(folder, "notes.txt"),
        join(folder, "..", "change-atlas", "..", "page.html"),
        join(folder, "git", "x", "a.html"),
        "settings.json",
    ]) {
        await assert.rejects(
            tool.execute({ id: "a", title: "A", path }, {}, {}),
            /must be a Change Atlas report/,
            path,
        );
    }

    await assert.rejects(
        tool.execute({ id: "a", title: "A", path: join(folder, "link.html") }, {}, {}),
        /ELOOP|symbolic link/,
    );
});

test("a Pocket whose artifact_inline already takes a path keeps its own tool", async () => {
    const { atlas } = await wrapped(await temp("data"));
    const wrap = (atlas.extension as unknown as { wraps: { wrap(t: object): object }[] }).wraps[0]!;
    const { tool } = builtIn();
    const own = {
        ...tool,
        parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, path: {} } },
    };

    assert.equal(wrap.wrap(own), own);
});

test("a replay finds its version when the report is gone; a new call without the file fails", async () => {
    const { atlas, tool, seen } = await wrapped(await temp("data"));
    const made = await atlas.call("change_atlas_publish", story);
    const path = /Wrote the Change Atlas: (\S+)/.exec(made)![1]!;

    await rm(path);
    await assert.rejects(
        tool.execute({ id: "a", title: "A", path }, {}, {}),
        /ENOENT/,
        "a new call says the file is missing",
    );
    await tool.execute({ id: "a", title: "A", path }, { published: true }, {});
    assert.deepEqual(seen.at(-1), { id: "a", title: "A" }, "the replay gets no content");
});

test("the wrap refuses a hard link, and reads no more than the limit", async () => {
    const dataDir = await temp("data");
    const { atlas, tool } = await wrapped(dataDir);
    const folder = join(dataDir, "change-atlas");

    await atlas.call("change_atlas_publish", story);
    const outside = join(await temp("secret"), "page.html");

    await writeFile(outside, "<p>SECRET</p>");
    await link(outside, join(folder, "hard.html"));
    await assert.rejects(
        tool.execute({ id: "a", title: "A", path: join(folder, "hard.html") }, {}, {}),
        /must be a Change Atlas report/,
    );

    await writeFile(join(folder, "big.html"), "x".repeat(2_000_001));
    await assert.rejects(
        tool.execute({ id: "a", title: "A", path: join(folder, "big.html") }, {}, {}),
        /too large to publish/,
    );
});

test("a broken settings file means inline, and a call can ask for the viewer", async () => {
    const atlas = await harness(await changed());

    await mkdir(join(atlas.dataDir, "change-atlas"), { recursive: true });
    await writeFile(join(atlas.dataDir, "change-atlas", "settings.json"), "{not json");
    assert.match(await atlas.call("change_atlas_publish", story), /call artifact_inline/);
    assert.match(
        await atlas.call("change_atlas_publish", { ...story, display: "viewer" }),
        /call artifact with path/,
    );
});

test("the wrap refuses a report folder that is a link, also when the file name is right", async () => {
    const dataDir = await temp("data");
    const { atlas, tool } = await wrapped(dataDir);
    const folder = join(dataDir, "change-atlas");
    const made = await atlas.call("change_atlas_publish", story);
    const name = /Wrote the Change Atlas: (\S+)/.exec(made)![1]!.split("/").pop()!;
    const outside = await temp("secret");

    await writeFile(join(outside, name), "<p>SECRET</p>");
    await rm(folder, { recursive: true });
    await symlink(outside, folder);
    await assert.rejects(
        tool.execute({ id: "a", title: "A", path: join(folder, name) }, {}, {}),
        /is not a folder/,
    );
});
