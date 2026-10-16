import { startBoot } from "./boot.ts";
import { h } from "./dom.ts";
import { celebrateMerges, surgeRain } from "./fx.ts";
import type { DashboardData, MergedPr } from "../shared/types.ts";

const GITHUB_URL = "https://github.com";
const FX_OFF_KEY = "fxOff";

const storedFxOff = () => {
    try {
        return localStorage.getItem(FX_OFF_KEY) === "1";
    } catch {
        return false;
    }
};

// Pauses the continuous effects; style.css and bg.ts read the class, and bg.ts restarts on the event
const setFxOff = (off: boolean) => {
    document.documentElement.classList.toggle("fx-off", off);
    try {
        localStorage.setItem(FX_OFF_KEY, off ? "1" : "0");
    } catch {
        // the choice just won't survive a reload
    }
    dispatchEvent(new CustomEvent("fx-change"));
};

document.documentElement.classList.toggle("fx-off", storedFxOff());

const latestMerge = (data: DashboardData | null): MergedPr =>
    data?.recentMerges.toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0] ?? {
        number: 1234,
        title: "Test merge",
        url: data ? `${GITHUB_URL}/${data.repo}/pulls` : GITHUB_URL,
        mergedAt: "",
    };

const replayCountGlitch = () =>
    document.querySelectorAll<HTMLElement>(".tile[data-tab]").forEach((tile) => {
        tile.classList.remove("changed");
        void tile.offsetWidth; // restart the animation
        tile.classList.add("changed");
    });

// Manual triggers for the effects; none of them touch the seen-merge tracking
export const mountFxMenu = (loadedData: () => DashboardData | null) => {
    const actions: [string, () => void][] = [
        ["Merge breach", () => celebrateMerges([latestMerge(loadedData())])],
        ["Count glitch", replayCountGlitch],
        ["Boot sequence", () => startBoot(true)(loadedData())],
        ["Rain surge", surgeRain],
    ];
    const toggle = h("button", { type: "button", class: "fx-toggle", "aria-expanded": "false", "aria-controls": "fx-menu", "aria-label": "fx effects menu" }, "fx");
    const buttons = actions.map(([label]) => h("button", { type: "button" }, label));
    const fxOffButton = h("button", { type: "button", "aria-pressed": String(storedFxOff()) }, "FX off");
    fxOffButton.addEventListener("click", () => {
        const off = !document.documentElement.classList.contains("fx-off");
        setFxOff(off);
        fxOffButton.setAttribute("aria-pressed", String(off));
    });
    const menu = h("div", { id: "fx-menu", class: "fx-menu", hidden: true }, fxOffButton, buttons);
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
            toggle.focus();
            actions[i]?.[1]();
        }),
    );
    root.addEventListener("focusout", (e) => {
        if (!(e.relatedTarget instanceof Node && root.contains(e.relatedTarget))) {
            setOpen(false);
        }
    });
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
