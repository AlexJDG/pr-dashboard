import { h } from "./dom.ts";
import { randomGlyph } from "./glyphs.ts";
import type { MergedPr } from "../shared/types.ts";

const TEAR_COUNT = 5;
const TEAR_MIN_PX = 3;
const TEAR_SPREAD_PX = 18;
const TEAR_DELAY_MS = 150;
const TEAR_MS = 450;
const PERCENT = 100;
const TERMINAL_OPEN_MS = 550;
const TERMINAL_LINE_MS = 380;
const TERMINAL_HOLD_MS = 6000;
const TERMINAL_OUT_MS = 350;
const HEX_BYTES = 8;
const BYTE_VALUES = 256;
const HEX_RADIX = 16;
const MAX_LISTED_PRS = 3;
const TYPE_TICK_MS = 30;
const TYPE_CHARS_PER_TICK = 2;

const motionReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const terminalOrigin = () => {
    const rect = document.querySelector(".tile.stat")?.getBoundingClientRect();
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) {
        return { x: innerWidth / 2, y: innerHeight / 2 };
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const randomHexBytes = () =>
    Array.from({ length: HEX_BYTES }, () => Math.floor(Math.random() * BYTE_VALUES).toString(HEX_RADIX).padStart(2, "0")).join(" ");

const tearScreen = () => {
    const tears = Array.from({ length: TEAR_COUNT }, () =>
        h("span", {
            class: "tear",
            style: `top:${Math.random() * PERCENT}%;height:${TEAR_MIN_PX + Math.random() * TEAR_SPREAD_PX}px;animation-delay:${Math.random() * TEAR_DELAY_MS}ms`,
        }),
    );
    const layer = h("div", { class: "fx-layer", "aria-hidden": "true" }, tears);
    document.body.append(layer);
    setTimeout(() => layer.remove(), TEAR_MS + TEAR_DELAY_MS);
};

const announcer = h("div", { class: "visually-hidden", "aria-live": "polite" });
document.body.append(announcer);

const breach = (prs: MergedPr[], animate: boolean) => {
    if (prs.length === 0) {
        return;
    }
    document.querySelector(".breach")?.remove();
    const listed = prs.slice(0, MAX_LISTED_PRS);
    const lines = [
        h("div", { class: "cmd" }, `$ git merge --ff ${listed.map((pr) => `#${pr.number}`).join(" ")}`),
        h("div", { class: "hex" }, `0x ${randomHexBytes()}`),
        h("div", { class: "hex" }, `0x ${randomHexBytes()}`),
        h("div", { class: "ok" }, prs.length > 1 ? `[OK] ${prs.length} PRs merged into main` : "[OK] merged into main"),
        ...listed.map((pr) => h("a", { class: "pr", href: pr.url, rel: "noopener", "aria-label": `#${pr.number} ${pr.title}` }, `▲ #${pr.number} ${pr.title}`)),
        prs.length > MAX_LISTED_PRS ? h("div", { class: "hex" }, `+${prs.length - MAX_LISTED_PRS} more`) : null,
    ].filter((line) => line !== null);
    const output = h("div", { class: "breach-output" }, lines);
    const { x, y } = terminalOrigin();
    // Opens at the centre of the window, travelling there from the Merged tile
    const travel = `--dx:${x - innerWidth / 2}px;--dy:${y - innerHeight / 2}px`;
    const terminal = h("div", { class: "breach", style: travel }, h("div", { class: "breach-bar", "aria-hidden": "true" }, "uplink"), output);
    document.body.append(terminal);
    announcer.textContent = prs.map((pr) => `Merged #${pr.number}: ${pr.title}`).join(". ");
    if (animate) {
        tearScreen();
        // Sized to the full text first so the window doesn't grow as lines type in
        output.style.minHeight = `${output.offsetHeight}px`;
        lines.forEach((line) => line.classList.add("pending"));
        lines.forEach((line, i) =>
            setTimeout(() => {
                line.classList.remove("pending");
                glitchType(line, line.textContent ?? "");
            }, TERMINAL_OPEN_MS + i * TERMINAL_LINE_MS),
        );
    }
    const closeAt = (animate ? TERMINAL_OPEN_MS + lines.length * TERMINAL_LINE_MS : 0) + TERMINAL_HOLD_MS;
    setTimeout(() => terminal.classList.add("out"), closeAt);
    setTimeout(() => terminal.remove(), closeAt + TERMINAL_OUT_MS);
};

// Reveals the text left to right, with a random glyph standing in for the character being typed
const glitchType = (element: HTMLElement, text: string) => {
    let revealed = 0;
    const timer = setInterval(() => {
        revealed += TYPE_CHARS_PER_TICK;
        if (revealed >= text.length) {
            element.textContent = text;
            clearInterval(timer);
            return;
        }
        element.textContent = text.slice(0, revealed) + randomGlyph();
    }, TYPE_TICK_MS);
    return timer;
};

// One breach and rain surge however many merges arrive together
export const celebrateMerges = (prs: MergedPr[]) => {
    const animate = !motionReduced();
    breach(prs, animate);
    if (animate && prs.length > 0) {
        surgeRain();
    }
};

export const surgeRain = () => dispatchEvent(new CustomEvent("rain-surge"));
