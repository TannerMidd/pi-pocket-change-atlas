import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Host, Web } from "../_pocket.d.ts";
import setup from "../change-atlas.ts";

// No user or system Git settings: a test must give the same result on every machine.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

type Tool = {
    name: string;
    annotations?: { readOnlyHint?: boolean };
    execute(args: object, api: object, context: unknown): Promise<{ output: { text: string }[] }>;
};

/** Like `host.text`, but easy to see in a result: `Q[…]` is a quoted line, `D[…]` is defanged text. */
export const text = {
    quoted: (value: string, max = 120) =>
        `Q[${value
            .replace(/[\r\n\0]+/g, " ")
            .replace(/</g, "‹")
            .slice(0, max)}]`,
    defang: (value: string) => `D[${value.replace(/<(?=[^<>]{0,80}\/)/g, "‹")}]`,
};

export async function temp(prefix: string) {
    return mkdtemp(join(tmpdir(), `change-atlas-${prefix}-`));
}

export function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with one commit, `a.txt` ("hello"), on `main`. */
export async function repo(parent?: string, name = "repo") {
    const dir = join(parent ?? (await temp("repo")), name);

    await mkdir(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    await writeFile(join(dir, "a.txt"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "first");

    return dir;
}

/** A fake `gh` that logs its arguments and prints the JSON in `json`. */
export async function fakeGh(json: object) {
    const dir = await temp("gh");
    const log = join(dir, "calls.log");

    await writeFile(join(dir, "reply.json"), JSON.stringify(json));
    await writeFile(
        join(dir, "gh"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncat '${join(dir, "reply.json")}'\n`,
    );
    await chmod(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}${delimiter}${(process.env.PATH ?? "")
        .split(delimiter)
        .filter((part) => !part.includes("change-atlas-gh-"))
        .join(delimiter)}`;

    return {
        calls: () => readFile(log, "utf8").catch(() => ""),
        remove: () => rm(dir, { recursive: true, force: true }),
    };
}

/**
 * A `git` in front of the real one. A `git fetch` from an https address is never run: it is logged, and it stops
 * (nothing in a test may reach the network), or, with `source`, it fetches the last argument from that folder
 * instead, with no hardening settings. Every other call goes to the real `git`.
 */
export async function fakeGit(source?: string) {
    const dir = await temp("git");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const log = join(dir, "fetches.log");
    const fetch = source
        ? `unset GIT_CONFIG_COUNT\nfor last; do :; done\nexec '${real}' fetch --no-tags -q '${source}' "$last"`
        : "exit 1";

    await writeFile(
        join(dir, "git"),
        `#!/bin/sh
case " $* " in
    *" fetch "*"https://"*) printf '%s\\n' "$*" >> '${log}'; ${fetch} ;;
esac
exec '${real}' "$@"
`,
    );
    await chmod(join(dir, "git"), 0o755);
    process.env.PATH = `${dir}${delimiter}${(process.env.PATH ?? "")
        .split(delimiter)
        .filter((part) => !part.includes("change-atlas-git-"))
        .join(delimiter)}`;

    return {
        fetches: () => readFile(log, "utf8").catch(() => ""),
        remove: () => rm(dir, { recursive: true, force: true }),
    };
}

/** `artifact_inline` with this module's wrap: it takes a path. */
export const INLINE_TOOL = {
    name: "artifact_inline",
    parameters: { properties: { id: {}, title: {}, content: {}, path: {}, edits: {} } },
};

type Command = {
    scope: string;
    handler(args: string, ctx: unknown): Promise<{ type: string; message?: string }>;
};

export async function harness(
    cwd: string,
    options: { dataDir?: string; tools?: { name: string; parameters?: object }[] } = {},
) {
    const dataDir = options.dataDir ?? (await temp("data"));
    const clients: [string, unknown][] = [];
    const routes: string[] = [];
    const commands = new Map<string, Command>();
    const web = {
        client: (name: string, spec: unknown) => clients.push([name, spec]),
        route: (method: string, path: string) => routes.push(`${method} ${path}`),
        conversationRoute: (method: string, path: string) => routes.push(`${method} ${path}`),
        command: (name: string, command: Command) => commands.set(name, command),
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
        send: () => undefined,
        onDispose: () => undefined,
    };
    const extension = (await setup(
        { dataDir, text } as unknown as Host,
        web as unknown as Web,
    )) as unknown as {
        name: string;
        tools: Tool[];
        wraps: unknown[];
    };
    const tools = new Map(extension.tools.map((tool) => [tool.name, tool]));
    const api = {
        agent: async () => ({ cwd, tools: options.tools ?? [INLINE_TOOL], deferred: [] }),
        taskId: "task-1",
        callId: "call-1",
    };
    const call = async (name: string, args: object) => {
        const result = await tools.get(name)!.execute(args, api, {});

        return result.output.map((part) => part.text).join("\n");
    };
    const fails = async (name: string, args: object, pattern: RegExp) => {
        await assert.rejects(call(name, args), pattern);
    };

    return { dataDir, extension, tools, clients, routes, commands, call, fails };
}
