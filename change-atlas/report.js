/* Change Atlas report: renders the embedded data. No outside requests. */
(function () {
    "use strict";

    const SVGNS = "http://www.w3.org/2000/svg";
    const STATUS_COLOR = {
        added: "var(--add)",
        removed: "var(--del)",
        deleted: "var(--del)",
        changed: "var(--mod)",
        modified: "var(--mod)",
        typechange: "var(--mod)",
        renamed: "var(--ren)",
        copied: "var(--ren)",
        unchanged: "var(--unch)",
    };
    const STATUS_HEX = {
        added: "#2ea043",
        deleted: "#da3633",
        modified: "#c38410",
        typechange: "#c38410",
        renamed: "#8957e5",
        copied: "#8957e5",
    };
    const KIND_COLOR = {
        feature: "#4c9aff",
        fix: "#f0883e",
        refactor: "#b083f0",
        test: "#3fb950",
        docs: "#39c5cf",
        config: "#8b98a8",
        build: "#8b98a8",
        style: "#db61a2",
        perf: "#e3b341",
        security: "#f85149",
        chore: "#6e7a8a",
    };
    const PALETTE = [
        "#4c9aff",
        "#b083f0",
        "#3fb950",
        "#f0883e",
        "#39c5cf",
        "#db61a2",
        "#e3b341",
        "#ff7b72",
        "#7ee787",
        "#a5d6ff",
        "#d2a8ff",
        "#ffa657",
    ];
    const LETTER = {
        added: "A",
        deleted: "D",
        modified: "M",
        renamed: "R",
        copied: "C",
        typechange: "T",
    };

    let data;

    try {
        data = JSON.parse(document.getElementById("atlas-data").textContent);
    } catch (error) {
        fatal("The report data is damaged: " + error.message);

        return;
    }

    window.addEventListener("error", (event) => fatal("The report failed: " + event.message));

    function fatal(message) {
        const app = document.getElementById("app");

        if (app && !app.dataset.ok) {
            app.textContent = "";
            app.append(el("p", { class: "fatal" }, message));
        }
    }

    // ── DOM helpers ─────────────────────────────────────────────────────

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);

        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || value === false) {
                continue;
            }

            if (key === "on") {
                for (const [type, fn] of Object.entries(value)) {
                    node.addEventListener(type, fn);
                }
            } else if (key === "style" && typeof value === "object") {
                Object.assign(node.style, value);
            } else if (key === "vars") {
                for (const [name, v] of Object.entries(value)) {
                    node.style.setProperty(name, v);
                }
            } else {
                node.setAttribute(key, value === true ? "" : String(value));
            }
        }

        append(node, children);

        return node;
    }

    function append(node, children) {
        for (const child of children.flat(Infinity)) {
            if (child === undefined || child === null || child === false) {
                continue;
            }

            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
    }

    function svg(tag, attrs, ...children) {
        const node = document.createElementNS(SVGNS, tag);

        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null) {
                continue;
            }

            if (key === "on") {
                for (const [type, fn] of Object.entries(value)) {
                    node.addEventListener(type, fn);
                }
            } else {
                node.setAttribute(key, String(value));
            }
        }

        append(node, children);

        return node;
    }

    const fmt = (n) =>
        n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : n.toLocaleString();
    const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
    const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
    const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
    const churn = (f) => f.additions + f.deletions;
    const slug = (text) =>
        String(text)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");

    function toast(text) {
        const node = el("div", { class: "toast", role: "status" }, text);

        document.body.append(node);
        setTimeout(() => node.remove(), 2600);
    }

    // ── Ask Pi (in the Pi Pocket viewer only) ──────────────────────────

    const embedded = window.parent && window.parent !== window;

    window.addEventListener("message", (event) => {
        if (
            event.source !== window.parent ||
            !event.data ||
            event.data.type !== "pocket-follow-up"
        ) {
            return;
        }

        if (!event.data.ok) {
            toast(event.data.error || "The app did not take the question.");
        }
    });

    function askButton(label, text) {
        if (!embedded) {
            return null;
        }

        return el(
            "button",
            {
                class: "ask",
                type: "button",
                on: {
                    click(event) {
                        event.stopPropagation();
                        window.parent.postMessage(
                            {
                                type: "pocket-follow-up",
                                text: `About the Change Atlas "${data.story.title}" (${data.label}): ${text}`.slice(
                                    0,
                                    2000,
                                ),
                            },
                            "*",
                        );
                    },
                },
            },
            "✦ ",
            label,
        );
    }

    // ── Matching files ──────────────────────────────────────────────────

    // A glob: `*` is any text in one folder name, `**` is any text. Without a closing `/` it also fits what is below
    // a match. The pattern comes from Pi, so this builds no regular expression from it (that could take minutes):
    // it follows the pattern's states along the path once.
    function globber(p) {
        if (p.length > 500) {
            return () => false;
        }

        const tokens = [...p.matchAll(/\*+|[^*]/g)].map((m) => (m[0].length > 1 ? "**" : m[0]));
        const below = !p.endsWith("/");
        const open = (states, from) => {
            let at = from;

            states.add(at);

            while (tokens[at] === "*" || tokens[at] === "**") {
                states.add(++at);
            }
        };

        return (path) => {
            const accepted = (states, at) =>
                states.has(tokens.length) && (at === path.length || (below && path[at] === "/"));
            let states = new Set();

            open(states, 0);

            for (let at = 0; at < path.length; at++) {
                if (accepted(states, at)) {
                    return true;
                }

                const next = new Set();

                for (const state of states) {
                    const token = tokens[state];

                    if (token === "**" || (token === "*" && path[at] !== "/")) {
                        open(next, state);
                    } else if (token === path[at]) {
                        open(next, state + 1);
                    }
                }

                states = next;
            }

            return accepted(states, path.length);
        };
    }

    // A pattern gives a score for a path: 0 for no match, else how specific the pattern is.
    function matcher(pattern) {
        const p = String(pattern).trim().replace(/^\.\//, "");
        const score = p.replace(/\*/g, "").length + 1;

        if (p === "*" || p === "(root)") {
            return (path) => (!path.includes("/") ? 1 : 0);
        }

        if (p.includes("*")) {
            const glob = globber(p);

            return (path) => (glob(path) ? score : 0);
        }

        if (p.endsWith("/")) {
            return (path) => (path.startsWith(p) ? score : 0);
        }

        return (path) => (path === p ? score + 1000 : path.startsWith(p + "/") ? score : 0);
    }

    function matchAny(patterns) {
        const fns = (patterns || []).map(matcher);

        return (path) => fns.reduce((best, fn) => Math.max(best, path ? fn(path) : 0), 0);
    }

    // The item whose patterns fit the path best; the first one wins a tie.
    function bestOf(list, file) {
        let best = null;
        let top = 0;

        for (const item of list) {
            if (!item.match) {
                continue;
            }

            const score = Math.max(item.match(file.path), item.match(file.oldPath));

            if (score > top) {
                top = score;
                best = item;
            }
        }

        return best;
    }

    const files = data.files;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const notes = new Map((data.story.fileNotes || []).map((n) => [n.path, n.note]));
    const totals = files.reduce((sum, f) => ({ a: sum.a + f.additions, d: sum.d + f.deletions }), {
        a: 0,
        d: 0,
    });

    // Areas: Pi's groups, or the auto components.
    const autoParts = data.auto.components.filter((c) => c.status !== "unchanged");
    const kindOfLayer = {
        Tests: "test",
        Docs: "docs",
        "Build and config": "config",
    };
    const areaSpecs =
        data.story.areas && data.story.areas.length
            ? data.story.areas
            : autoParts.map((c) => ({
                  name: c.name,
                  kind: kindOfLayer[c.layer] || "chore",
                  summary: "",
                  files: c.paths,
                  auto: true,
              }));
    const areas = areaSpecs.map((spec, index) => ({
        ...spec,
        id: "area-" + index,
        kind: (spec.kind || "chore").toLowerCase(),
        color: PALETTE[index % PALETTE.length],
        match: matchAny(spec.files),
        files: [],
    }));
    const other = {
        id: "area-other",
        name: "Other changes",
        kind: "chore",
        summary: "",
        color: "#6e7a8a",
        files: [],
    };
    const areaOf = new Map();

    for (const file of files) {
        const area = bestOf(areas, file) || other;

        area.files.push(file);
        areaOf.set(file.path, area);
    }

    if (other.files.length) {
        areas.push(other);
    }

    const liveAreas = areas.filter((a) => a.files.length);

    for (const area of liveAreas) {
        area.a = area.files.reduce((s, f) => s + f.additions, 0);
        area.d = area.files.reduce((s, f) => s + f.deletions, 0);
    }

    function head(title, small, lead, tools) {
        return el(
            "div",
            { class: "sec-head" },
            el(
                "div",
                {},
                el("h2", {}, title, small ? el("small", {}, small) : null),
                lead ? el("p", { class: "lead" }, lead) : null,
            ),
            tools || null,
        );
    }

    function segmented(options, value, onChange) {
        const box = el("div", { class: "seg", role: "group" });

        for (const [key, label] of options) {
            box.append(
                el(
                    "button",
                    {
                        type: "button",
                        class: key === value ? "on" : null,
                        "aria-pressed": String(key === value),
                        on: {
                            click() {
                                for (const b of box.children) {
                                    b.classList.toggle("on", b === this);
                                    b.setAttribute("aria-pressed", String(b === this));
                                }

                                onChange(key);
                            },
                        },
                    },
                    label,
                ),
            );
        }

        return box;
    }

    function churnBar(a, d, max) {
        const total = Math.max(1, max || a + d);

        return el(
            "div",
            { class: "churn" },
            el("span", { class: "a", style: { width: (a / total) * 100 + "%" } }),
            el("span", { class: "d", style: { width: (d / total) * 100 + "%" } }),
        );
    }

    function fileChip(path) {
        const file = byPath.get(path);
        const fits = matcher(path);
        const matches = file ? [file] : files.filter((f) => fits(f.path) > 0);

        if (!matches.length) {
            return el(
                "span",
                { class: "fchip", title: "Not in this change" },
                el("span", {}, path),
            );
        }

        if (matches.length > 1) {
            return el(
                "button",
                {
                    class: "fchip",
                    type: "button",
                    on: { click: () => filterFiles(path) },
                },
                el("span", {}, path),
                el("span", { class: "n" }, String(matches.length)),
            );
        }

        const f = matches[0];

        return el(
            "button",
            {
                class: "fchip",
                type: "button",
                title: f.path,
                on: { click: () => openFile(f.path) },
            },
            el("span", {}, basename(f.path)),
            el("span", { class: "n" }, `+${f.additions} −${f.deletions}`),
        );
    }

    // ── Hero ────────────────────────────────────────────────────────────

    function hero() {
        const story = data.story;
        const highRisk = (story.risks || []).filter(
            (r) => String(r.level).toLowerCase() === "high",
        ).length;
        const eyebrow = el(
            "div",
            { class: "eyebrow" },
            el("span", { class: "chip brand" }, "◆ Change Atlas"),
            el("span", { class: "chip" }, el("b", {}, data.repo)),
            data.pr && /^https:\/\//i.test(String(data.pr.url))
                ? el(
                      "a",
                      {
                          class: "chip",
                          href: data.pr.url,
                          target: "_blank",
                          rel: "noopener",
                      },
                      data.label,
                  )
                : el("span", { class: "chip" }, data.label),
            data.pr && data.pr.author
                ? el("span", { class: "chip" }, "by ", el("b", {}, data.pr.author))
                : null,
            highRisk
                ? el(
                      "span",
                      { class: "chip" },
                      el("i", { class: "dot", style: { background: "var(--del)" } }),
                      plural(highRisk, "high risk"),
                  )
                : null,
        );

        return el(
            "header",
            { class: "hero" },
            el(
                "div",
                { class: "hero-inner" },
                eyebrow,
                el("h1", {}, story.title),
                el(
                    "ul",
                    { class: "summary" },
                    (story.summary || []).map((line) => el("li", {}, line)),
                ),
                story.intent
                    ? el("p", { class: "intent" }, el("b", {}, "Why"), story.intent)
                    : null,
                el(
                    "div",
                    { class: "kpis" },
                    kpi(fmt(files.length), "files changed"),
                    kpi("+" + fmt(totals.a), "lines added", "add"),
                    kpi("−" + fmt(totals.d), "lines removed", "del"),
                    data.commits.length
                        ? kpi(
                              fmt(data.commits.length),
                              plural(data.commits.length, "commit").replace(/^[\d,.k]+ /, ""),
                          )
                        : null,
                    kpi(String(liveAreas.length), liveAreas.length === 1 ? "area" : "areas"),
                    kpi(data.ste.score + "%", "STE sentences pass"),
                ),
            ),
        );
    }

    function kpi(value, label, cls) {
        return el(
            "div",
            { class: "kpi " + (cls || "") },
            el("div", { class: "v" }, value),
            el("div", { class: "k" }, label),
        );
    }

    // ── Overview ────────────────────────────────────────────────────────

    function overview(node) {
        node.append(
            head(
                "At a glance",
                null,
                "Each color is one area of the change. The width shows the lines that change.",
            ),
        );

        const total = Math.max(
            1,
            liveAreas.reduce((s, a) => s + a.a + a.d, 0),
        );
        const bar = el("div", { class: "mixbar" });
        const legend = el("div", { class: "legend" });

        for (const area of liveAreas) {
            const share = (area.a + area.d) / total;

            bar.append(
                el("span", {
                    title: `${area.name}: +${area.a} −${area.d}`,
                    style: {
                        width: Math.max(share * 100, 0.6) + "%",
                        background: area.color,
                    },
                    on: { click: () => jump(area.id) },
                }),
            );
            legend.append(
                el(
                    "span",
                    {},
                    el("i", { style: { background: area.color } }),
                    area.name,
                    " ",
                    el("b", {}, Math.round(share * 100) + "%"),
                ),
            );
        }

        // Status counts.
        const counts = {};

        for (const f of files) {
            counts[f.status] = (counts[f.status] || 0) + 1;
        }

        const statusBar = el("div", {
            class: "mixbar",
            style: { marginTop: "16px", height: "10px" },
        });
        const statusLegend = el("div", { class: "legend" });

        for (const [status, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
            statusBar.append(
                el("span", {
                    style: {
                        width: (n / files.length) * 100 + "%",
                        background: STATUS_COLOR[status],
                    },
                    title: `${n} ${status}`,
                }),
            );
            statusLegend.append(
                el(
                    "span",
                    {},
                    el("i", { style: { background: STATUS_COLOR[status] } }),
                    `${n} ${status}`,
                ),
            );
        }

        const hot = el("div", { class: "card hot" }, el("h3", {}, "Hotspots"));
        const top = [...files]
            .filter((f) => !f.generated)
            .sort((a, b) => churn(b) - churn(a))
            .slice(0, 7);
        const max = Math.max(1, ...top.map(churn));

        for (const f of top) {
            hot.append(
                el(
                    "div",
                    {
                        class: "hotrow",
                        title: f.path,
                        on: { click: () => openFile(f.path) },
                    },
                    el("div", { class: "p" }, "\u200e" + f.path),
                    churnBar(f.additions, f.deletions, max),
                ),
            );
        }

        node.append(
            el(
                "div",
                { class: "grid2" },
                el(
                    "div",
                    { class: "card mix" },
                    el("h3", {}, "Change mix by area"),
                    bar,
                    legend,
                    el("h3", { style: { marginTop: "18px" } }, "Files by status"),
                    statusBar,
                    statusLegend,
                ),
                hot,
            ),
        );
    }

    function jump(id) {
        const target = document.getElementById(id);

        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.remove("flash");
            void target.offsetWidth;
            target.classList.add("flash");
        }
    }

    // ── Architecture ────────────────────────────────────────────────────

    function architecture(node) {
        const given = data.story.architecture;
        const spec = given && given.components && given.components.length ? given : null;
        const comps = (spec ? spec.components : data.auto.components).map((c) => ({
            ...c,
            status: normStatus(c.status),
            match: c.paths && c.paths.length ? matchAny(c.paths) : null,
        }));
        const ids = new Set(comps.map((c) => c.id));
        const rawLinks = (spec ? spec.links || [] : data.auto.links).filter(
            (l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to,
        );
        const linksList = rawLinks.map((l) => ({
            ...l,
            status: normStatus(l.status),
        }));

        for (const c of comps) {
            c.files = [];
        }

        for (const f of files) {
            const owner = bestOf(comps, f);

            if (owner) {
                owner.files.push(f);
            }
        }

        for (const c of comps) {
            c.a = c.files.reduce((s, f) => s + f.additions, 0);
            c.d = c.files.reduce((s, f) => s + f.deletions, 0);
        }

        let mode = "diff";
        let selected = null;
        const box = el("div", { class: "card arch" });
        const scroll = el("div", { class: "arch-scroll", "data-no-swipe": "" });
        const detail = el("div", { class: "detail" });
        const legend = el(
            "div",
            { class: "legend", style: { marginTop: 0 } },
            ["added", "changed", "removed", "unchanged"].map((s) =>
                el("span", {}, el("i", { style: { background: STATUS_COLOR[s] } }), s),
            ),
        );

        box.append(
            el(
                "div",
                { class: "arch-tools" },
                segmented(
                    [
                        ["before", "Before"],
                        ["diff", "Changes"],
                        ["after", "After"],
                    ],
                    mode,
                    (value) => {
                        mode = value;
                        draw();
                    },
                ),
                legend,
            ),
            scroll,
            detail,
        );

        node.append(
            head(
                "Architecture",
                spec ? null : "from folders and imports",
                given && given.summary
                    ? given.summary
                    : "Components and the links between them. Tap a component to see what changes in it.",
            ),
            box,
        );

        // Layers: given order, else a fixed order for the auto layers, else levels from the links.
        const AUTO_ORDER = [
            "Interface",
            "Extensions",
            "Core",
            "Data",
            "Build and config",
            "Tests",
            "Docs",
        ];
        let layerNames;

        if (spec && comps.some((c) => c.layer)) {
            layerNames = [...(spec.layers || [])];

            for (const c of comps) {
                c.layer = c.layer || "Other";

                if (!layerNames.includes(c.layer)) {
                    layerNames.push(c.layer);
                }
            }
        } else if (!spec) {
            layerNames = AUTO_ORDER.filter((name) => comps.some((c) => c.layer === name));

            for (const c of comps) {
                if (!layerNames.includes(c.layer)) {
                    layerNames.push(c.layer);
                }
            }
        } else {
            const level = levels(comps, linksList);

            layerNames = [];

            for (const c of comps) {
                c.layer = "Level " + (level.get(c.id) + 1);
            }

            const max = Math.max(...level.values());

            for (let i = 0; i <= max; i++) {
                layerNames.push("Level " + (i + 1));
            }
        }

        layerNames = layerNames.filter((name) => comps.some((c) => c.layer === name));

        function draw() {
            const visible = comps.filter((c) =>
                mode === "before"
                    ? c.status !== "added"
                    : mode === "after"
                      ? c.status !== "removed"
                      : true,
            );
            const vis = new Set(visible.map((c) => c.id));
            const edges = linksList.filter(
                (l) =>
                    vis.has(l.from) &&
                    vis.has(l.to) &&
                    (mode === "before"
                        ? l.status !== "added"
                        : mode === "after"
                          ? l.status !== "removed"
                          : true),
            );
            const rows = layerNames
                .map((name) => visible.filter((c) => c.layer === name))
                .filter((row) => row.length);

            orderRows(rows, edges);

            // Rows wrap to fit the frame, so the diagram never needs a sideways scroll.
            const frame = scroll.clientWidth || 900;
            const narrow = frame < 640;
            const W = narrow ? 150 : 176;
            const H = 60;
            const GX = narrow ? 14 : 26;
            const GY = 78;
            const SUB = 40;
            const PAD = narrow ? 10 : 20;
            const LABEL = 28;
            const perLine = Math.max(
                narrow ? 1 : 3,
                Math.floor((frame - 8 - PAD * 2 + GX) / (W + GX)),
            );
            const bands = rows.map((row) => {
                const lines = [];

                for (let i = 0; i < row.length; i += perLine) {
                    lines.push(row.slice(i, i + perLine));
                }

                return lines;
            });
            const widest = Math.max(1, ...bands.flat().map((line) => line.length));
            const width = Math.max(
                narrow ? frame - 8 : 360,
                PAD * 2 + widest * W + (widest - 1) * GX,
            );
            const pos = new Map();
            const bandBoxes = [];
            let y = PAD;
            let lineIndex = 0;

            bands.forEach((lines, r) => {
                const top = y;

                y += LABEL;

                lines.forEach((line, k) => {
                    const lineW = line.length * W + (line.length - 1) * GX;
                    const x0 = (width - lineW) / 2;

                    line.forEach((c, i) =>
                        pos.set(c.id, { x: x0 + i * (W + GX), y, r: lineIndex }),
                    );
                    lineIndex++;
                    y += H + (k < lines.length - 1 ? SUB : 0);
                });

                bandBoxes.push({ top, bottom: y + 10, name: rows[r][0].layer });
                y += GY - LABEL + 10;
            });

            const height = y - (GY - LABEL + 10) + 10 + PAD;
            const nameMax = Math.floor((W - 34) / 7.6);

            const root = svg("svg", {
                viewBox: `0 0 ${width} ${height}`,
                width,
                height,
                role: "img",
                "aria-label": "Architecture diagram",
                style: `width:100%;max-width:${width}px;height:auto`,
            });
            const defs = svg("defs");

            for (const status of ["added", "changed", "removed", "unchanged"]) {
                defs.append(
                    svg(
                        "marker",
                        {
                            id: "arrow-" + status,
                            viewBox: "0 0 10 10",
                            refX: 9,
                            refY: 5,
                            markerWidth: 7,
                            markerHeight: 7,
                            orient: "auto-start-reverse",
                        },
                        svg("path", {
                            d: "M0,0 L10,5 L0,10 z",
                            fill: STATUS_COLOR[status],
                        }),
                    ),
                );
            }

            root.append(defs);

            for (const band of bandBoxes) {
                root.append(
                    svg("rect", {
                        class: "band",
                        x: 4,
                        y: band.top,
                        width: width - 8,
                        height: band.bottom - band.top,
                        rx: 14,
                    }),
                    svg("text", { class: "layer-label", x: 16, y: band.top + 18 }, band.name),
                );
            }

            // Spread the ends of edges that share a side of a node.
            const ends = new Map();

            const slot = (id, side) => {
                const key = id + side;
                const n = ends.get(key) || 0;

                ends.set(key, n + 1);

                return n;
            };

            const edgeLayer = svg("g");
            const labelLayer = svg("g");
            const edgeNodes = [];
            const placed = [];

            for (const link of edges) {
                const a = pos.get(link.from);
                const b = pos.get(link.to);
                let d;
                let mid;

                if (a.r === b.r) {
                    const ax = a.x + W / 2 + (slot(link.from, "t") - 1) * 10;
                    const bx = b.x + W / 2 + (slot(link.to, "t") - 1) * 10;
                    const lift = 34 + Math.abs(ax - bx) * 0.08;

                    d = `M${ax},${a.y} C${ax},${a.y - lift} ${bx},${b.y - lift} ${bx},${b.y - 2}`;
                    mid = { x: (ax + bx) / 2, y: a.y - lift * 0.75 };
                } else {
                    const down = b.r > a.r;
                    const ax = a.x + W / 2 + ((slot(link.from, down ? "b" : "t") % 5) - 2) * 14;
                    const bx = b.x + W / 2 + ((slot(link.to, down ? "t" : "b") % 5) - 2) * 14;
                    const ay = down ? a.y + H : a.y;
                    const by = down ? b.y - 2 : b.y + H + 2;
                    const bend = Math.max(30, Math.abs(by - ay) * 0.45);

                    d = `M${ax},${ay} C${ax},${ay + (down ? bend : -bend)} ${bx},${by + (down ? -bend : bend)} ${bx},${by}`;
                    mid = { x: (ax + bx) / 2, y: (ay + by) / 2 };
                }

                const path = svg("path", {
                    class: "edge " + link.status,
                    d,
                    stroke: STATUS_COLOR[link.status],
                    "marker-end": `url(#arrow-${link.status})`,
                });

                path.append(
                    svg(
                        "title",
                        {},
                        `${nameOf(link.from)} → ${nameOf(link.to)}${link.label ? " (" + link.label + ")" : ""}: ${link.status}`,
                    ),
                );
                edgeLayer.append(path);

                let label = null;

                if (link.label) {
                    // Move a label down until it does not cover another one.
                    const half = link.label.length * 3.1 + 4;

                    for (
                        let tries = 0;
                        tries < 6 &&
                        placed.some(
                            (box) =>
                                Math.abs(box.x - mid.x) < box.half + half &&
                                Math.abs(box.y - mid.y) < 13,
                        );
                        tries++
                    ) {
                        mid.y += 13;
                    }

                    placed.push({ x: mid.x, y: mid.y, half });
                    label = svg(
                        "text",
                        { class: "elabel", x: mid.x, y: mid.y, "text-anchor": "middle" },
                        link.label,
                    );
                    labelLayer.append(label);
                }

                edgeNodes.push({ link, path, label });
            }

            root.append(edgeLayer);

            const nodeEls = new Map();

            for (const c of visible) {
                const p = pos.get(c.id);
                const color = STATUS_COLOR[c.status];
                const g = svg("g", {
                    class: "node " + c.status + (selected === c.id ? " sel" : ""),
                    transform: `translate(${p.x},${p.y})`,
                    tabindex: 0,
                    role: "button",
                    "aria-label": `${c.name}, ${c.status}`,
                    on: {
                        click: () => select(c.id),
                        keydown: (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                select(c.id);
                            }
                        },
                    },
                });

                if (c.status === "added") {
                    g.append(
                        svg("rect", {
                            class: "glow",
                            x: -4,
                            y: -4,
                            width: W + 8,
                            height: H + 8,
                            rx: 15,
                            fill: "none",
                            stroke: color,
                            "stroke-width": 6,
                            opacity: 0.35,
                        }),
                    );
                }

                g.append(
                    svg("rect", {
                        class: "body",
                        width: W,
                        height: H,
                        rx: 12,
                        stroke: color,
                    }),
                    svg("rect", {
                        x: 0,
                        y: 10,
                        width: 4,
                        height: H - 20,
                        rx: 2,
                        fill: color,
                    }),
                    svg("text", { x: 14, y: 25 }, clip(c.name, nameMax)),
                    svg(
                        "text",
                        { class: "sub", x: 14, y: 44 },
                        c.files.length
                            ? `${c.files.length} file${c.files.length === 1 ? "" : "s"} · +${fmt(c.a)} −${fmt(c.d)}`
                            : c.status,
                    ),
                    svg("circle", { cx: W - 14, cy: 14, r: 4.5, fill: color }),
                    svg("title", {}, `${c.name} (${c.status})${c.summary ? "\n" + c.summary : ""}`),
                );

                if (c.files.length) {
                    // A small bar of added and removed lines along the bottom edge.
                    const total = Math.max(1, c.a + c.d);
                    const span = W - 28;

                    g.append(
                        svg("rect", {
                            x: 14,
                            y: H - 9,
                            width: span,
                            height: 3,
                            rx: 1.5,
                            fill: "var(--line)",
                        }),
                        svg("rect", {
                            x: 14,
                            y: H - 9,
                            width: (span * c.a) / total,
                            height: 3,
                            rx: 1.5,
                            fill: "var(--add)",
                        }),
                        svg("rect", {
                            x: 14 + (span * c.a) / total,
                            y: H - 9,
                            width: (span * c.d) / total,
                            height: 3,
                            rx: 1.5,
                            fill: "var(--del)",
                        }),
                    );
                }

                nodeEls.set(c.id, g);
                root.append(g);
            }

            root.append(labelLayer);

            // Dim what is not linked to the selection.
            if (selected && vis.has(selected)) {
                const near = new Set([selected]);

                for (const { link } of edgeNodes) {
                    if (link.from === selected || link.to === selected) {
                        near.add(link.from);
                        near.add(link.to);
                    }
                }

                for (const [id, g] of nodeEls) {
                    g.classList.toggle("dim", !near.has(id));
                }

                for (const { link, path, label } of edgeNodes) {
                    const on = link.from === selected || link.to === selected;

                    path.classList.toggle("dim", !on);

                    if (label) {
                        label.classList.toggle("dim", !on);
                    }
                }
            }

            scroll.textContent = "";
            scroll.append(root);
            showDetail();
        }

        function nameOf(id) {
            const c = comps.find((x) => x.id === id);

            return c ? c.name : id;
        }

        function select(id) {
            selected = selected === id ? null : id;
            draw();
        }

        function showDetail() {
            detail.textContent = "";
            const c = comps.find((x) => x.id === selected);

            if (!c) {
                const counts = { added: 0, changed: 0, removed: 0 };

                for (const x of comps) {
                    if (counts[x.status] !== undefined) {
                        counts[x.status]++;
                    }
                }

                const linkCounts = { added: 0, removed: 0 };

                for (const l of linksList) {
                    if (linkCounts[l.status] !== undefined) {
                        linkCounts[l.status]++;
                    }
                }

                detail.append(
                    el(
                        "div",
                        { class: "hint" },
                        `${plural(comps.length, "component")}: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed. ` +
                            `${plural(linksList.length, "link")}: ${linkCounts.added} added, ${linkCounts.removed} removed. Tap a component for its details.`,
                    ),
                );

                return;
            }

            const out = linksList.filter((l) => l.from === c.id);
            const into = linksList.filter((l) => l.to === c.id);

            detail.append(
                el(
                    "div",
                    { class: "ttl" },
                    c.name,
                    el("span", { class: "st " + c.status }, c.status),
                    c.layer ? el("span", { class: "chip" }, c.layer) : null,
                ),
                c.summary ? el("p", {}, c.summary) : null,
                out.length || into.length
                    ? el(
                          "p",
                          { class: "hint" },
                          [
                              ...out.map(
                                  (l) => `→ ${l.label || "uses"} ${nameOf(l.to)} (${l.status})`,
                              ),
                              ...into.map(
                                  (l) =>
                                      `← ${nameOf(l.from)} ${l.label || "uses"} it (${l.status})`,
                              ),
                          ].join(" · "),
                      )
                    : null,
                c.files.length
                    ? el(
                          "div",
                          { class: "filechips" },
                          c.files.slice(0, 24).map((f) => fileChip(f.path)),
                          c.files.length > 24
                              ? el("span", { class: "hint" }, `+${c.files.length - 24} more`)
                              : null,
                      )
                    : null,
                el(
                    "div",
                    { style: { marginTop: "10px" } },
                    askButton(
                        "Ask Pi about this component",
                        `Explain the changes in the component "${c.name}" and how they affect its links, in ASD-STE100.`,
                    ),
                ),
            );
        }

        let lastWidth = 0;

        new ResizeObserver(() => {
            if (Math.abs(scroll.clientWidth - lastWidth) > 4) {
                lastWidth = scroll.clientWidth;
                draw();
            }
        }).observe(scroll);
    }

    function normStatus(value) {
        const s = String(value || "").toLowerCase();

        if (s.startsWith("add") || s === "new") {
            return "added";
        }

        if (s.startsWith("rem") || s.startsWith("del")) {
            return "removed";
        }

        if (s.startsWith("unch") || s === "same" || s === "kept") {
            return "unchanged";
        }

        return "changed";
    }

    function clip(text, max) {
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }

    // Longest-path levels; a cycle keeps the level it had when it was first met.
    function levels(comps, links) {
        const out = new Map(comps.map((c) => [c.id, []]));

        for (const l of links) {
            out.get(l.from).push(l.to);
        }

        const level = new Map();
        const visiting = new Set();

        function visit(id) {
            if (level.has(id)) {
                return level.get(id);
            }

            if (visiting.has(id)) {
                return 0;
            }

            visiting.add(id);
            let best = 0;

            for (const next of out.get(id)) {
                best = Math.max(best, visit(next) + 1);
            }

            visiting.delete(id);
            level.set(id, best);

            return best;
        }

        for (const c of comps) {
            visit(c.id);
        }

        const max = Math.max(0, ...level.values());

        for (const [id, value] of level) {
            level.set(id, max - value);
        }

        return level;
    }

    // Barycenter sweeps: fewer crossings between rows.
    function orderRows(rows, edges) {
        const neighbors = new Map();

        for (const e of edges) {
            (neighbors.get(e.from) || neighbors.set(e.from, []).get(e.from)).push(e.to);
            (neighbors.get(e.to) || neighbors.set(e.to, []).get(e.to)).push(e.from);
        }

        for (let pass = 0; pass < 6; pass++) {
            const index = new Map();

            for (const row of rows) {
                row.forEach((c, i) => index.set(c.id, i / Math.max(1, row.length - 1)));
            }

            for (const row of rows) {
                const score = new Map(
                    row.map((c, i) => {
                        const near = (neighbors.get(c.id) || []).filter(
                            (id) => index.has(id) && !row.some((x) => x.id === id),
                        );
                        const mean = near.length
                            ? near.reduce((s, id) => s + index.get(id), 0) / near.length
                            : i / Math.max(1, row.length - 1);

                        return [c.id, mean];
                    }),
                );

                row.sort((a, b) => score.get(a.id) - score.get(b.id));
            }
        }
    }

    // ── Change map (treemap) ────────────────────────────────────────────

    function changeMap(node) {
        let group = "area";
        let color = "status";
        const box = el("div", { class: "treemap", "data-no-swipe": "" });

        node.append(
            head(
                "Change map",
                null,
                "Each tile is one file. Its size shows the lines that change. Tap a tile to open its diff.",
            ),
            el(
                "div",
                { class: "card tm-card" },
                el(
                    "div",
                    { class: "tm-tools" },
                    segmented(
                        [
                            ["area", "By area"],
                            ["folder", "By folder"],
                        ],
                        group,
                        (v) => {
                            group = v;
                            draw();
                        },
                    ),
                    segmented(
                        [
                            ["status", "Status"],
                            ["balance", "Add vs remove"],
                        ],
                        color,
                        (v) => {
                            color = v;
                            draw();
                        },
                    ),
                ),
                box,
                el("div", { class: "legend", id: "tm-legend" }),
            ),
        );

        function groups() {
            if (group === "area") {
                return liveAreas.map((a) => ({
                    name: a.name,
                    color: a.color,
                    files: a.files,
                }));
            }

            const map = new Map();

            for (const f of files) {
                const parts = f.path.split("/");
                const key =
                    parts.length > 2
                        ? parts.slice(0, 2).join("/")
                        : parts.length === 2
                          ? parts[0]
                          : "(root)";

                map.set(key, [...(map.get(key) || []), f]);
            }

            return [...map].map(([name, list], i) => ({
                name,
                color: PALETTE[i % PALETTE.length],
                files: list,
            }));
        }

        const weight = (f) => {
            const n = Math.max(1, churn(f));

            return f.generated ? Math.min(n, 40) : n;
        };

        function tileColor(f) {
            if (color === "status") {
                return STATUS_HEX[f.status] || "#6e7a8a";
            }

            const total = Math.max(1, churn(f));
            const share = f.additions / total;
            // Red (all removed) to green (all added) through slate.
            const mix = (a, b, t) => Math.round(a + (b - a) * t);
            const from = share < 0.5 ? [218, 54, 51] : [90, 104, 122];
            const to = share < 0.5 ? [90, 104, 122] : [46, 160, 67];
            const t = share < 0.5 ? share * 2 : (share - 0.5) * 2;

            return `rgb(${mix(from[0], to[0], t)},${mix(from[1], to[1], t)},${mix(from[2], to[2], t)})`;
        }

        function draw() {
            const width = box.clientWidth || 600;
            const height = Math.round(
                Math.min(560, Math.max(260, width * (width < 600 ? 1.1 : 0.55))),
            );

            box.style.height = height + "px";
            box.textContent = "";

            const list = groups()
                .map((g) => ({
                    ...g,
                    value: g.files.reduce((s, f) => s + weight(f), 0),
                }))
                .sort((a, b) => b.value - a.value);
            const outer = squarify(list, { x: 0, y: 0, w: width, h: height });

            for (const g of outer) {
                const inset = 2;
                const r = {
                    x: g.x + inset,
                    y: g.y + inset,
                    w: g.w - inset * 2,
                    h: g.h - inset * 2,
                };
                const header = r.h > 46 && r.w > 70 ? 20 : 0;
                const groupEl = el("div", {
                    class: "tm-group",
                    title: `${g.item.name}: ${g.item.files.length} files`,
                    style: {
                        left: r.x + "px",
                        top: r.y + "px",
                        width: Math.max(0, r.w) + "px",
                        height: Math.max(0, r.h) + "px",
                        background: `color-mix(in srgb, ${g.item.color} 16%, var(--panel))`,
                    },
                });

                if (header) {
                    groupEl.append(
                        el("div", { class: "gh", style: { color: g.item.color } }, g.item.name),
                    );
                }

                const inner = squarify(
                    g.item.files
                        .map((f) => ({ file: f, value: weight(f) }))
                        .sort((a, b) => b.value - a.value),
                    { x: 2, y: header + 2, w: r.w - 4, h: r.h - header - 4 },
                );

                for (const t of inner) {
                    const f = t.item.file;
                    const pad = 1.5;
                    const w = t.w - pad * 2;
                    const h = t.h - pad * 2;

                    if (w <= 0 || h <= 0) {
                        continue;
                    }

                    groupEl.append(
                        el(
                            "div",
                            {
                                class: "tm-tile",
                                title: `${f.path}\n${f.status} · +${f.additions} −${f.deletions}${notes.has(f.path) ? "\n" + notes.get(f.path) : ""}`,
                                style: {
                                    left: t.x + pad + "px",
                                    top: t.y + pad + "px",
                                    width: w + "px",
                                    height: h + "px",
                                    background: tileColor(f),
                                },
                                on: { click: () => openFile(f.path) },
                            },
                            w > 44 && h > 18 ? el("b", {}, basename(f.path)) : null,
                            w > 54 && h > 34
                                ? el("i", {}, `+${f.additions} −${f.deletions}`)
                                : null,
                        ),
                    );
                }

                box.append(groupEl);
            }

            const legend = node.querySelector("#tm-legend");

            legend.textContent = "";

            if (color === "status") {
                for (const s of ["added", "modified", "renamed", "deleted"]) {
                    legend.append(
                        el("span", {}, el("i", { style: { background: STATUS_HEX[s] } }), s),
                    );
                }
            } else {
                legend.append(
                    el(
                        "span",
                        {},
                        el("i", { style: { background: "rgb(218,54,51)" } }),
                        "only removed",
                    ),
                    el(
                        "span",
                        {},
                        el("i", { style: { background: "rgb(90,104,122)" } }),
                        "balanced",
                    ),
                    el(
                        "span",
                        {},
                        el("i", { style: { background: "rgb(46,160,67)" } }),
                        "only added",
                    ),
                );
            }

            if (files.some((f) => f.generated)) {
                legend.append(el("span", {}, "Generated files show smaller."));
            }
        }

        let last = 0;

        new ResizeObserver(() => {
            if (Math.abs(box.clientWidth - last) > 4) {
                last = box.clientWidth;
                draw();
            }
        }).observe(box);
        draw();
    }

    function squarify(items, rect) {
        const total = items.reduce((s, i) => s + i.value, 0);
        const out = [];

        if (!total || rect.w <= 0 || rect.h <= 0) {
            return out;
        }

        const scale = (rect.w * rect.h) / total;
        const nodes = items.map((item) => ({ item, area: item.value * scale }));
        const r = { ...rect };
        let row = [];

        const worst = (list, side) => {
            const s = list.reduce((a, n) => a + n.area, 0);
            const max = Math.max(...list.map((n) => n.area));
            const min = Math.min(...list.map((n) => n.area));

            return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
        };

        const place = (list) => {
            const s = list.reduce((a, n) => a + n.area, 0);

            if (r.w >= r.h) {
                const colW = s / r.h;
                let y = r.y;

                for (const n of list) {
                    const h = n.area / colW;

                    out.push({ item: n.item, x: r.x, y, w: colW, h });
                    y += h;
                }

                r.x += colW;
                r.w -= colW;
            } else {
                const rowH = s / r.w;
                let x = r.x;

                for (const n of list) {
                    const w = n.area / rowH;

                    out.push({ item: n.item, x, y: r.y, w, h: rowH });
                    x += w;
                }

                r.y += rowH;
                r.h -= rowH;
            }
        };

        let i = 0;

        while (i < nodes.length) {
            const side = Math.min(r.w, r.h);
            const next = nodes[i];

            if (!row.length || worst([...row, next], side) <= worst(row, side)) {
                row.push(next);
                i++;
            } else {
                place(row);
                row = [];
            }
        }

        if (row.length) {
            place(row);
        }

        return out;
    }

    // ── Walkthrough ─────────────────────────────────────────────────────

    function walkthrough(node) {
        node.append(head("Walkthrough", null, "Read the change in this order."));

        const list = el("ol", { class: "steps" });

        data.story.walkthrough.forEach((step, i) => {
            list.append(
                el(
                    "li",
                    { class: "step" },
                    el("div", { class: "num" }, String(i + 1)),
                    el(
                        "div",
                        { class: "card" },
                        el("h3", {}, step.title),
                        el("p", {}, step.text),
                        step.files && step.files.length
                            ? el("div", { class: "filechips" }, step.files.map(fileChip))
                            : null,
                    ),
                ),
            );
        });

        node.append(list);
    }

    // ── Areas ───────────────────────────────────────────────────────────

    function areasSection(node) {
        node.append(head("Areas", null, "Related files in groups. Tap an area to see its files."));

        const grid = el("div", { class: "areas" });
        const max = Math.max(1, ...liveAreas.map((a) => a.a + a.d));

        for (const area of liveAreas) {
            const kindColor = KIND_COLOR[area.kind] || "#6e7a8a";

            grid.append(
                el(
                    "div",
                    {
                        class: "card area",
                        id: area.id,
                        vars: { "--c": area.color },
                        tabindex: 0,
                        role: "button",
                        on: {
                            click: () => filterArea(area.id),
                            keydown: (event) => {
                                if (event.key === "Enter") {
                                    filterArea(area.id);
                                }
                            },
                        },
                    },
                    el(
                        "h3",
                        {},
                        area.name,
                        el("span", { class: "kind", vars: { "--c": kindColor } }, area.kind),
                    ),
                    area.summary ? el("p", {}, area.summary) : null,
                    el(
                        "div",
                        { class: "meta" },
                        el("span", {}, plural(area.files.length, "file")),
                        churnBar(area.a, area.d, max),
                        el("span", { class: "mono" }, `+${fmt(area.a)} −${fmt(area.d)}`),
                    ),
                ),
            );
        }

        node.append(grid);
    }

    // ── Risks, checks, dependencies ─────────────────────────────────────

    function risksSection(node) {
        const risks = [...(data.story.risks || [])];
        const order = { high: 0, medium: 1, low: 2 };

        risks.sort(
            (a, b) =>
                (order[String(a.level).toLowerCase()] ?? 3) -
                (order[String(b.level).toLowerCase()] ?? 3),
        );
        node.append(
            head(
                "Risks & checks",
                null,
                risks.length ? "What can go wrong, and what to check." : null,
            ),
        );

        if (risks.length) {
            const list = el("div", { class: "risks" });

            for (const risk of risks) {
                const level = String(risk.level || "low").toLowerCase();

                list.append(
                    el(
                        "div",
                        { class: "card risk" },
                        el(
                            "div",
                            { class: "lvl " + (order[level] !== undefined ? level : "low") },
                            level,
                        ),
                        el(
                            "div",
                            {},
                            el("p", {}, risk.text),
                            risk.files && risk.files.length
                                ? el("div", { class: "filechips" }, risk.files.map(fileChip))
                                : null,
                            el(
                                "div",
                                { style: { marginTop: "6px" } },
                                askButton(
                                    "Ask Pi how to check",
                                    `Tell me how to check this risk, in ASD-STE100: ${risk.text}`,
                                ),
                            ),
                        ),
                    ),
                );
            }

            node.append(list);
        }

        if ((data.story.checks || []).length) {
            const icon = {
                passed: "✓",
                added: "+",
                failed: "✕",
                missing: "!",
                manual: "◦",
            };

            node.append(
                el("h3", { class: "sub-h" }, "Tests and checks"),
                el(
                    "ul",
                    { class: "card checks" },
                    data.story.checks.map((check) => {
                        const status = String(check.status || "none").toLowerCase();

                        return el(
                            "li",
                            {},
                            el(
                                "span",
                                { class: "ic " + (icon[status] ? status : "none") },
                                icon[status] || "•",
                            ),
                            el(
                                "span",
                                {},
                                check.text,
                                check.status
                                    ? el(
                                          "span",
                                          {
                                              class: "hint",
                                              style: {
                                                  marginLeft: "8px",
                                                  color: "var(--muted)",
                                                  fontSize: "12px",
                                              },
                                          },
                                          status,
                                      )
                                    : null,
                            ),
                        );
                    }),
                ),
            );
        }

        if (data.dependencies.length) {
            const table = el(
                "table",
                { class: "deps" },
                el(
                    "tr",
                    {},
                    el("th", {}, "Package"),
                    el("th", {}, "Before"),
                    el("th", {}, "After"),
                    el("th", {}, "Group"),
                ),
            );

            for (const dep of data.dependencies) {
                const status = !dep.before ? "added" : !dep.after ? "removed" : "changed";

                table.append(
                    el(
                        "tr",
                        {},
                        el(
                            "td",
                            { class: "mono" },
                            el(
                                "span",
                                { class: "st " + status, style: { marginRight: "8px" } },
                                status,
                            ),
                            dep.name,
                        ),
                        el("td", { class: "mono" }, dep.before || "—"),
                        el("td", { class: "mono" }, dep.after || "—"),
                        el("td", { class: "mono", title: dep.file }, dep.group),
                    ),
                );
            }

            node.append(
                el("h3", { class: "sub-h" }, "Dependencies"),
                el("div", { class: "card", style: { overflowX: "auto" } }, table),
            );
        }

        if (data.externalImports.length) {
            node.append(
                el("h3", { class: "sub-h" }, "Outside packages in imports"),
                el(
                    "div",
                    { class: "filechips" },
                    data.externalImports.map((imp) =>
                        el(
                            "span",
                            { class: "fchip", title: imp.files.join("\n") },
                            el(
                                "span",
                                { class: "st " + imp.change },
                                imp.change === "added" ? "new" : "gone",
                            ),
                            el("span", {}, imp.name),
                            el("span", { class: "n" }, String(imp.files.length)),
                        ),
                    ),
                ),
            );
        }
    }

    // ── Files and diffs ─────────────────────────────────────────────────

    const fileEls = new Map();

    let applyFilter = () => {};

    function filesSection(node) {
        const search = el("input", {
            type: "search",
            placeholder: "Find a file",
            "aria-label": "Find a file",
        });
        const areaSel = el(
            "select",
            { "aria-label": "Area" },
            el("option", { value: "" }, "All areas"),
            liveAreas.map((a) => el("option", { value: a.id }, a.name)),
        );
        let status = "all";
        const list = el("div", { class: "card files" });
        const empty = el("div", { class: "empty", hidden: true }, "No file matches.");

        node.append(
            head(
                "Files",
                `+${fmt(totals.a)} −${fmt(totals.d)}`,
                "Tap a file to see its diff and Pi's note.",
            ),
            el(
                "div",
                { class: "ftools" },
                search,
                areaSel,
                segmented(
                    [
                        ["all", "All"],
                        ["notes", "With notes"],
                        ["added", "Added"],
                        ["deleted", "Deleted"],
                    ],
                    status,
                    (v) => {
                        status = v;
                        applyFilter();
                    },
                ),
            ),
            list,
            empty,
        );

        if (data.skippedFiles) {
            node.append(
                el(
                    "p",
                    { class: "lead" },
                    `${data.skippedFiles} more files are not in this report.`,
                ),
            );
        }

        const max = Math.max(1, ...files.map(churn));

        for (const f of files) {
            const row = fileRow(f, max);

            fileEls.set(f.path, row);
            list.append(row);
        }

        applyFilter = () => {
            const q = search.value.trim().toLowerCase();
            const areaId = areaSel.value;
            let shown = 0;

            for (const f of files) {
                const row = fileEls.get(f.path);
                const ok =
                    (!q ||
                        f.path.toLowerCase().includes(q) ||
                        (f.oldPath || "").toLowerCase().includes(q)) &&
                    (!areaId || areaOf.get(f.path).id === areaId) &&
                    (status === "all" ||
                        (status === "notes"
                            ? notes.has(f.path)
                            : status === "added"
                              ? f.status === "added"
                              : f.status === "deleted"));

                row.hidden = !ok;
                shown += ok ? 1 : 0;
            }

            empty.hidden = shown > 0;
        };

        search.addEventListener("input", applyFilter);
        areaSel.addEventListener("change", applyFilter);
        filterFiles.search = search;
        filterFiles.area = areaSel;
    }

    function filterFiles(text) {
        if (filterFiles.search) {
            filterFiles.search.value = String(text).replace(/\*+/g, "");
            filterFiles.area.value = "";
            applyFilter();
            document.getElementById("files").scrollIntoView({ behavior: "smooth" });
        }
    }

    function filterArea(id) {
        if (filterFiles.area) {
            filterFiles.search.value = "";
            filterFiles.area.value = id;
            applyFilter();
            document.getElementById("files").scrollIntoView({ behavior: "smooth" });
        }
    }

    function openFile(path) {
        const row = fileEls.get(path);

        if (!row) {
            return;
        }

        if (row.hidden && filterFiles.search) {
            filterFiles.search.value = "";
            filterFiles.area.value = "";
            applyFilter();
        }

        row.open = true;
        requestAnimationFrame(() => {
            row.scrollIntoView({ behavior: "smooth", block: "start" });
            row.classList.remove("flash");
            void row.offsetWidth;
            row.classList.add("flash");
        });
    }

    function fileRow(f, max) {
        const blocks = el("span", { class: "blocks", "aria-hidden": "true" });
        const total = churn(f);
        const filled = total
            ? Math.max(1, Math.round((Math.log1p(total) / Math.log1p(max)) * 5))
            : 0;
        const addBlocks = total ? Math.round((filled * f.additions) / total) : 0;

        for (let i = 0; i < 5; i++) {
            blocks.append(el("i", { class: i < addBlocks ? "a" : i < filled ? "d" : null }));
        }

        const details = el(
            "details",
            { class: "file", id: "file-" + slug(f.path) },
            el(
                "summary",
                {},
                el("span", { class: "sl " + f.status, title: f.status }, LETTER[f.status] || "M"),
                el(
                    "span",
                    {
                        class: "fpath",
                        title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
                    },
                    f.oldPath && f.oldPath !== f.path
                        ? el("span", { class: "old" }, f.oldPath + " ")
                        : null,
                    el("span", { class: "dir" }, dirOf(f.path)),
                    el("b", {}, basename(f.path)),
                    f.generated ? el("span", { class: "tag" }, "generated") : null,
                    f.binary ? el("span", { class: "tag" }, "binary") : null,
                ),
                el(
                    "span",
                    { class: "fstat" },
                    notes.has(f.path)
                        ? el("i", { class: "note-dot", title: "Pi wrote a note" })
                        : null,
                    el("span", { class: "a" }, "+" + fmt(f.additions)),
                    el("span", { class: "d" }, "−" + fmt(f.deletions)),
                    blocks,
                ),
            ),
        );
        let built = false;

        details.addEventListener("toggle", () => {
            if (details.open && !built) {
                built = true;
                details.append(fileBody(f));
            }
        });

        return details;
    }

    function fileBody(f) {
        const body = el("div", { class: "fbody" });
        const note = notes.get(f.path);
        const ask = askButton(
            "Ask Pi",
            `Explain the change in \`${f.path}\` line by line, in ASD-STE100.`,
        );

        if (note || ask) {
            body.append(
                el(
                    "div",
                    { class: "fnote" },
                    note ? el("p", {}, note) : el("span", { class: "hint" }, ""),
                    ask,
                ),
            );
        }

        if (f.binary) {
            body.append(el("div", { class: "empty" }, "A binary file. The report shows no diff."));

            return body;
        }

        if (!f.hunks.length) {
            body.append(
                el(
                    "div",
                    { class: "empty" },
                    f.generated
                        ? "A generated file. The report leaves out its diff."
                        : f.truncated
                          ? "The diff is too large for this report. Read it with git."
                          : f.status === "renamed"
                            ? "The file moves. Its content does not change."
                            : "No line changes (for example, a change of file mode).",
                ),
            );

            return body;
        }

        const lang = langOf(f.path);
        const diff = el("div", { class: "diff" });
        const rows = el("div", { class: "rows" });
        const LIMIT = 400;
        let shown = 0;
        let hunkIndex = 0;

        const more = el("button", {
            class: "more",
            type: "button",
            on: { click: () => renderMore() },
        });

        function renderMore() {
            let budget = LIMIT;

            while (hunkIndex < f.hunks.length && budget > 0) {
                const hunk = f.hunks[hunkIndex++];

                rows.append(
                    el(
                        "div",
                        { class: "ln hk" },
                        el("span", { class: "no" }, ""),
                        el("span", { class: "no" }, ""),
                        el("span", { class: "sg" }, ""),
                        el(
                            "span",
                            {},
                            `@@ −${hunk.oldStart} +${hunk.newStart} @@ ${hunk.header || ""}`,
                        ),
                    ),
                );

                const marks = pairMarks(hunk.lines);

                hunk.lines.forEach((line, i) => {
                    const [kind, oldNo, newNo, text] = line;

                    rows.append(
                        el(
                            "div",
                            {
                                class: "ln" + (kind === "+" ? " add" : kind === "-" ? " del" : ""),
                            },
                            el("span", { class: "no" }, oldNo ? String(oldNo) : ""),
                            el("span", { class: "no" }, newNo ? String(newNo) : ""),
                            el(
                                "span",
                                { class: "sg" },
                                kind === " " ? " " : kind === "+" ? "+" : "−",
                            ),
                            codeCell(text, lang, marks.get(i)),
                        ),
                    );
                });

                budget -= hunk.lines.length;
                shown += hunk.lines.length;
            }

            const left = f.hunks.length - hunkIndex;

            more.hidden = left === 0;
            more.textContent = left ? `Show ${plural(left, "more hunk")}` : "";
        }

        diff.append(rows);
        body.append(diff, more);
        renderMore();

        if (f.truncated) {
            body.append(
                el(
                    "div",
                    { class: "empty" },
                    "The report cuts this diff. Read the full diff with git.",
                ),
            );
        }

        return body;
    }

    // Pairs removed and added lines in a run, and marks the part of each line that changes.
    function pairMarks(lines) {
        const marks = new Map();
        let i = 0;

        while (i < lines.length) {
            if (lines[i][0] !== "-") {
                i++;
                continue;
            }

            const delStart = i;

            while (i < lines.length && lines[i][0] === "-") {
                i++;
            }

            const addStart = i;

            while (i < lines.length && lines[i][0] === "+") {
                i++;
            }

            const pairs = Math.min(addStart - delStart, i - addStart);

            for (let k = 0; k < pairs; k++) {
                const a = lines[delStart + k][3];
                const b = lines[addStart + k][3];

                if (a.length > 500 || b.length > 500) {
                    continue;
                }

                let p = 0;

                while (p < a.length && p < b.length && a[p] === b[p]) {
                    p++;
                }

                let s = 0;

                while (
                    s < a.length - p &&
                    s < b.length - p &&
                    a[a.length - 1 - s] === b[b.length - 1 - s]
                ) {
                    s++;
                }

                const same = p + s;

                if (same < 3 || same < Math.min(a.length, b.length) * 0.3) {
                    continue;
                }

                if (a.length - same > 0) {
                    marks.set(delStart + k, [p, a.length - s]);
                }

                if (b.length - same > 0) {
                    marks.set(addStart + k, [p, b.length - s]);
                }
            }
        }

        return marks;
    }

    function langOf(path) {
        const ext = (path.split(".").pop() || "").toLowerCase();

        if (
            [
                "py",
                "sh",
                "bash",
                "zsh",
                "rb",
                "yml",
                "yaml",
                "toml",
                "pl",
                "r",
                "conf",
                "ini",
                "dockerfile",
                "mk",
            ].includes(ext) ||
            /(^|\/)(Dockerfile|Makefile)$/.test(path)
        ) {
            return "hash";
        }

        if (["md", "txt", "json", "lock", "csv", "svg", "html", "xml"].includes(ext)) {
            return "plain";
        }

        return "c";
    }

    const KEYWORDS =
        "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|default|class|extends|new|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|def|lambda|type|interface|enum|public|private|protected|static|readonly|fn|pub|use|mod|struct|impl|trait|match|package|func|go|defer|true|false|null|undefined|nil|None|True|False|self|this|super|void|int|string|bool|boolean|number";
    const TOKENS = {
        c: new RegExp(
            `(\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$))|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
            "g",
        ),
        hash: new RegExp(
            `(#.*$)|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
            "g",
        ),
    };
    const TOKEN_CLASS = [null, "t-com", "t-str", "t-kw", "t-num"];

    function codeCell(text, lang, mark) {
        const cell = el("span", {});
        const segments = [];
        const re = TOKENS[lang];

        if (re && text.length < 1200) {
            let last = 0;

            re.lastIndex = 0;

            for (let m = re.exec(text); m; m = re.exec(text)) {
                if (m[0] === "") {
                    re.lastIndex++;
                    continue;
                }

                if (m.index > last) {
                    segments.push([text.slice(last, m.index), null]);
                }

                const group = [1, 2, 3, 4].find((g) => m[g] !== undefined);

                segments.push([m[0], TOKEN_CLASS[group]]);
                last = m.index + m[0].length;
            }

            if (last < text.length) {
                segments.push([text.slice(last), null]);
            }
        } else {
            segments.push([text, null]);
        }

        // Split the segments at the mark's ends, and wrap the marked parts.
        let at = 0;

        for (const [piece, cls] of segments) {
            const start = at;
            const end = at + piece.length;

            at = end;

            const cuts = [start, end];

            if (mark) {
                for (const edge of mark) {
                    if (edge > start && edge < end) {
                        cuts.push(edge);
                    }
                }
            }

            cuts.sort((a, b) => a - b);

            for (let k = 0; k < cuts.length - 1; k++) {
                const part = text.slice(cuts[k], cuts[k + 1]);

                if (!part) {
                    continue;
                }

                const inMark = mark && cuts[k] >= mark[0] && cuts[k + 1] <= mark[1];
                let node = cls ? el("span", { class: cls }, part) : document.createTextNode(part);

                if (inMark) {
                    node = el("mark", {}, node);
                }

                cell.append(node);
            }
        }

        return cell;
    }

    // ── Commits ─────────────────────────────────────────────────────────

    function commitsSection(node) {
        node.append(
            head("Commits", null, `${plural(data.commits.length, "commit")}, oldest first.`),
        );

        const list = el("ol", { class: "timeline" });

        for (const c of data.commits) {
            const when = new Date(c.date);

            list.append(
                el(
                    "li",
                    {},
                    el("span", { class: "dt" }),
                    el(
                        "div",
                        {},
                        el("div", { class: "s" }, c.subject),
                        el(
                            "div",
                            { class: "m" },
                            el("code", {}, c.sha.slice(0, 8)),
                            " · ",
                            c.author,
                            " · ",
                            isNaN(when) ? c.date : when.toLocaleString(),
                        ),
                    ),
                ),
            );
        }

        node.append(el("div", { class: "card", style: { padding: "10px 16px" } }, list));
    }

    // ── STE quality ─────────────────────────────────────────────────────

    function steSection(node) {
        const ste = data.ste;
        const r = 34;
        const length = 2 * Math.PI * r;
        const tone = ste.score >= 90 ? "var(--add)" : ste.score >= 70 ? "var(--mod)" : "var(--del)";
        const ring = svg(
            "svg",
            { class: "ring", width: 88, height: 88, viewBox: "0 0 88 88" },
            svg("circle", {
                cx: 44,
                cy: 44,
                r,
                fill: "none",
                stroke: "var(--line)",
                "stroke-width": 8,
            }),
            svg("circle", {
                cx: 44,
                cy: 44,
                r,
                fill: "none",
                stroke: tone,
                "stroke-width": 8,
                "stroke-linecap": "round",
                "stroke-dasharray": `${(length * ste.score) / 100} ${length}`,
                transform: "rotate(-90 44 44)",
            }),
            svg("text", { x: 44, y: 51, "text-anchor": "middle" }, ste.score + "%"),
        );

        node.append(
            head(
                "Simplified Technical English",
                null,
                "Pi writes this report in ASD-STE100. A check counts the sentences that follow its main rules.",
            ),
            el(
                "div",
                { class: "card" },
                el(
                    "div",
                    { class: "ste" },
                    ring,
                    el(
                        "div",
                        {},
                        el(
                            "div",
                            { style: { fontWeight: 700, fontSize: "16px" } },
                            `${ste.clean} of ${ste.sentences} sentences pass`,
                        ),
                        el(
                            "div",
                            { class: "lead" },
                            "The check looks for sentences of more than 25 words, contractions, the passive voice, semicolons, and words that STE does not approve. It is a guide, not a full STE review.",
                        ),
                    ),
                ),
                ste.issues.length
                    ? el(
                          "ul",
                          { class: "issues" },
                          ste.issues.map((issue) =>
                              el(
                                  "li",
                                  {},
                                  el("span", { class: "w" }, issue.where),
                                  el("q", {}, issue.text),
                                  el("span", { class: "pb" }, issue.problem),
                              ),
                          ),
                      )
                    : null,
            ),
        );
    }

    function start() {
        // ── Page frame (built last, once every helper exists) ──────────────────────────────────────────────────────

        const app = document.getElementById("app");

        app.textContent = "";
        app.dataset.ok = "1";

        const sections = [];

        function addSection(id, title, count, build) {
            sections.push({ id, title, count, build });
        }

        app.append(hero());

        const nav = el("nav", { class: "tabs", "aria-label": "Sections" });
        const wrap = el("main", { class: "wrap" });

        app.append(nav, wrap);

        addSection("overview", "Overview", null, overview);

        if (data.story.architecture || data.auto.components.length > 1) {
            addSection("architecture", "Architecture", null, architecture);
        }

        addSection("map", "Change map", null, changeMap);

        if ((data.story.walkthrough || []).length) {
            addSection("walkthrough", "Walkthrough", data.story.walkthrough.length, walkthrough);
        }

        addSection("areas", "Areas", liveAreas.length, areasSection);

        if (
            (data.story.risks || []).length ||
            (data.story.checks || []).length ||
            data.dependencies.length ||
            data.externalImports.length
        ) {
            addSection(
                "risks",
                "Risks & checks",
                (data.story.risks || []).length || null,
                risksSection,
            );
        }

        addSection("files", "Files", files.length, filesSection);

        if (data.commits.length) {
            addSection("commits", "Commits", data.commits.length, commitsSection);
        }

        addSection("ste", "STE", data.ste.score + "%", steSection);

        for (const sec of sections) {
            const link = el(
                "a",
                { href: "#" + sec.id, "data-id": sec.id },
                sec.title,
                sec.count !== null ? el("span", { class: "n" }, String(sec.count)) : null,
            );

            nav.append(link);

            const node = el("section", { id: sec.id });

            wrap.append(node);
            sec.build(node);
        }

        wrap.append(
            el(
                "footer",
                {},
                `Change Atlas · ${data.repo} · ${data.base.slice(0, 10)} → ${data.head === "WORKTREE" ? "working tree" : data.head.slice(0, 10)} · ${new Date(data.generatedAt).toLocaleString()}`,
            ),
        );

        // Scroll spy for the tabs.
        const links = [...nav.querySelectorAll("a")];
        const spy = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        for (const link of links) {
                            const on = link.dataset.id === entry.target.id;

                            link.classList.toggle("on", on);

                            if (on) {
                                // Scroll only the tab bar: scrollIntoView would stop the page's own scroll.
                                nav.scrollTo({
                                    left:
                                        link.offsetLeft -
                                        nav.clientWidth / 2 +
                                        link.clientWidth / 2,
                                    behavior: "smooth",
                                });
                            }
                        }
                    }
                }
            },
            { rootMargin: "-45% 0px -50% 0px" },
        );

        for (const sec of sections) {
            spy.observe(document.getElementById(sec.id));
        }
    }

    start();
})();
