// Change Atlas in the app: how its tool calls read, and a launcher action that starts one.
export const pocketApi = 1;

export default function setup(pocket) {
    pocket.toolCall({
        tool: "change_atlas_scan",
        icon: "search",
        label: () => "scan changes",
        subject: (args) => args.target || "local changes",
        summary: () => ({ verb: "scanned", noun: "change set", by: "target" }),
    });

    pocket.toolCall({
        tool: "change_atlas_publish",
        icon: "grid",
        label: () => "build change atlas",
        subject: (args) => args.title || args.target || "",
        summary: () => ({ verb: "built", noun: "change atlas", by: "title" }),
    });

    if (typeof pocket.insertText === "function") {
        pocket.launcher({
            id: "new",
            label: "Change Atlas: map a PR or branch",
            detail: "Ask Pi for a visual report of code changes, in ASD-STE100",
            icon: "grid",
            keywords: ["diff", "pull request", "review", "visualize", "ste", "architecture"],
            run: () =>
                pocket.insertText(
                    "Make a Change Atlas of local changes. (Or name a PR such as #12, a branch, or a range such as main...feature.)",
                ),
        });
    }
}
