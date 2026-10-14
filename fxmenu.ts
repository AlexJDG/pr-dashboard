import { startBoot } from "./boot.ts";
import { h } from "./dom.ts";
import { celebrateMerges, surgeRain } from "./fx.ts";
import type { DashboardData, MergedPr } from "./types.ts";

const PLACEHOLDER_MERGE: MergedPr = { number: 1234, title: "Test merge", url: "#", mergedAt: "" };

const latestMerge = (data: DashboardData | null) =>
    data?.recentMerges.toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0] ?? PLACEHOLDER_MERGE;

const replayCountGlitch = () =>
    document.querySelectorAll<HTMLElement>(".tile[data-tab]").forEach((tile) => {
        tile.classList.remove("changed");
        void tile.offsetWidth; // restart the animation
        tile.classList.add("changed");
    });

// Manual triggers for the effects; none of them touch the seen-merge tracking
export const mountFxMenu = (loadedData: () => DashboardData | null) => {
    const actions: [string, () => void][] = [
        ["Merge burst", () => celebrateMerges([latestMerge(loadedData())])],
        ["Count glitch", replayCountGlitch],
        ["Boot sequence", () => startBoot(true)(loadedData())],
        ["Rain surge", surgeRain],
    ];
    const toggle = h("button", { type: "button", class: "fx-toggle", "aria-expanded": "false", "aria-label": "Effects menu" }, "fx");
    const buttons = actions.map(([label]) => h("button", { type: "button" }, label));
    const menu = h("div", { class: "fx-menu", hidden: true }, buttons);
    const root = h("div", { class: "fx-root" }, toggle, menu);
    let isOpen = false;
    const setOpen = (open: boolean) => {
        isOpen = open;
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
    };
    buttons.forEach((button, i) =>
        button.addEventListener("click", () => {
            setOpen(false);
            actions[i]?.[1]();
        }),
    );
    toggle.addEventListener("click", () => setOpen(!isOpen));
    document.addEventListener("click", (e) => {
        if (e.target instanceof Node && !root.contains(e.target)) {
            setOpen(false);
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen) {
            setOpen(false);
            toggle.focus();
        }
    });
    document.body.append(root);
};
