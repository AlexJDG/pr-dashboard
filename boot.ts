import { h } from "./dom.ts";
import type { DashboardData } from "./types.ts";

const BOOTED_KEY = "booted";
const CHAR_MS = 8;
const LINE_PAUSE_MS = 60;
const HOLD_MS = 250;
const FAILURE_HOLD_MS = 1200;
const OUT_MS = 450;
const DATA_WAIT_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Claims the one boot per browser session; without working storage the boot is skipped rather than replayed on every reload
const claimBoot = () => {
    try {
        if (sessionStorage.getItem(BOOTED_KEY)) {
            return false;
        }
        sessionStorage.setItem(BOOTED_KEY, "1");
        return true;
    } catch {
        return false;
    }
};

const dataLines = (data: DashboardData) => {
    const openPrs = data.tabs.find((tab) => tab.key === "open")?.count ?? 0;
    return [
        `> authenticating as ${data.viewer}... OK`,
        `> scanning ${data.repo}... ${openPrs} open PRs`,
        "> decrypting merge queue... OK",
        "> ready_",
    ];
};

// Returns the function that hands over the first dashboard payload, or null if loading it failed. `replay` ignores the once-per-session limit and reduced motion.
export const startBoot = (replay = false) => {
    if (!replay && (matchMedia("(prefers-reduced-motion: reduce)").matches || !claimBoot())) {
        return () => {};
    }
    const output = h("pre", { class: "boot-output" });
    const overlay = h("div", { class: "boot" }, output);
    document.body.append(overlay);

    let finished = false;
    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        removeEventListener("keydown", finish);
        overlay.classList.add("out");
        setTimeout(() => overlay.remove(), OUT_MS);
    };
    overlay.addEventListener("click", finish);
    addEventListener("keydown", finish);

    let provide = (_data: DashboardData | null) => {};
    let timedOut = false;
    const firstData = new Promise<DashboardData | null>((resolve) => {
        provide = resolve;
        setTimeout(() => {
            timedOut = true;
            resolve(null);
        }, DATA_WAIT_MS);
    });

    const typeLine = async (text: string) => {
        const line = h("div");
        output.append(line);
        for (const char of text) {
            if (finished) {
                return line;
            }
            line.textContent += char;
            await sleep(CHAR_MS);
        }
        await sleep(LINE_PAUSE_MS);
        return line;
    };

    void (async () => {
        const uplink = await typeLine("> establishing uplink to github.com...");
        const data = await firstData;
        uplink.textContent += data ? " OK" : timedOut ? " TIMEOUT" : " FAILED";
        if (data) {
            for (const line of dataLines(data)) {
                await typeLine(line);
            }
        }
        await sleep(data ? HOLD_MS : FAILURE_HOLD_MS);
        finish();
    })();

    return provide;
};
