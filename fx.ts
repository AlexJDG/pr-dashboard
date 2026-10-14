import { h } from "./dom.ts";
import { randomGlyph } from "./glyphs.ts";
import type { MergedPr } from "./types.ts";

const TEAR_COUNT = 5;
const TEAR_MIN_PX = 3;
const TEAR_SPREAD_PX = 18;
const TEAR_DELAY_MS = 150;
const TEAR_MS = 450;
const PERCENT = 100;
const TERMINAL_LINE_MS = 380;
const TERMINAL_HOLD_MS = 900;
const TERMINAL_OUT_MS = 350;
const HEX_BYTES = 8;
const BYTE_VALUES = 256;
const HEX_RADIX = 16;
const MAX_TOASTS = 3;
const TOAST_MS = 6000;
const TOAST_OUT_MS = 500;
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

const breach = (prs: MergedPr[]) => {
    const [first] = prs;
    if (!first) {
        return;
    }
    tearScreen();
    const { x, y } = terminalOrigin();
    const lines = [
        { kind: "cmd", text: `$ git merge --ff #${first.number}` },
        { kind: "hex", text: `0x ${randomHexBytes()}` },
        { kind: "hex", text: `0x ${randomHexBytes()}` },
        { kind: "ok", text: prs.length > 1 ? `[OK] ${prs.length} PRs merged into main` : "[OK] merged into main" },
    ];
    const output = h("div", { class: "breach-output" });
    const terminal = h("div", { class: "breach", style: `left:${x}px;top:${y}px`, "aria-hidden": "true" }, h("div", { class: "breach-bar" }, "uplink"), output);
    document.body.append(terminal);
    lines.forEach(({ kind, text }, i) =>
        setTimeout(() => {
            const line = h("div", { class: kind });
            output.append(line);
            glitchType(line, text);
        }, i * TERMINAL_LINE_MS),
    );
    const closeAt = lines.length * TERMINAL_LINE_MS + TERMINAL_HOLD_MS;
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

const toastStack = () => {
    const existing = document.querySelector(".toasts");
    if (existing) {
        return existing;
    }
    const created = h("div", { class: "toasts" });
    document.body.append(created);
    return created;
};

const announcer = h("div", { class: "visually-hidden", "aria-live": "polite" });
document.body.append(announcer);

const dismissers = new WeakMap<Element, () => void>();

const showToast = (pr: MergedPr, animate: boolean) => {
    const head = h("b", { class: "toast-head" });
    const title = h("span", { class: "toast-title" });
    const plainText = `Merged #${pr.number}: ${pr.title}`;
    head.setAttribute("aria-hidden", "true");
    title.setAttribute("aria-hidden", "true");
    const toast = h("a", { class: "toast", href: pr.url, rel: "noopener", "aria-label": plainText }, head, title);
    announcer.textContent = plainText;
    const heading = `▲ MERGED #${pr.number}`;
    const typing = animate ? [glitchType(head, heading), glitchType(title, pr.title)] : [];
    if (!animate) {
        head.textContent = heading;
        title.textContent = pr.title;
    }
    const stack = toastStack();
    const outTimer = setTimeout(() => toast.classList.add("out"), TOAST_MS);
    const removeTimer = setTimeout(() => dismiss(), TOAST_MS + TOAST_OUT_MS);
    const dismiss = () => {
        typing.forEach(clearInterval);
        clearTimeout(outTimer);
        clearTimeout(removeTimer);
        toast.remove();
        if (!stack.hasChildNodes()) {
            stack.remove();
        }
    };
    dismissers.set(toast, dismiss);
    stack.append(toast);
    [...stack.children].slice(0, -MAX_TOASTS).forEach((oldest) => dismissers.get(oldest)?.());
};

// One breach and rain surge however many merges arrive together
export const celebrateMerges = (prs: MergedPr[]) => {
    const animate = !motionReduced();
    prs.forEach((pr) => showToast(pr, animate));
    if (animate && prs.length > 0) {
        breach(prs);
        surgeRain();
    }
};

export const surgeRain = () => dispatchEvent(new CustomEvent("rain-surge"));
