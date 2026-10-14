import { h } from "./dom.ts";
import { randomGlyph } from "./glyphs.ts";
import type { MergedPr } from "./types.ts";

const SHARD_COUNT = 30;
const SHARD_MIN_PX = 90;
const SHARD_SPREAD_PX = 260;
const SHARD_DELAY_MS = 120;
const RING_STAGGER_MS = 140;
const RING_COUNT = 2;
const BURST_MS = 1600;
const TOAST_MS = 6000;
const TOAST_OUT_MS = 500;
const TYPE_TICK_MS = 30;
const TYPE_CHARS_PER_TICK = 2;
const FULL_TURN = Math.PI * 2;

const motionReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const burstOrigin = () => {
    const rect = document.querySelector(".tile.stat")?.getBoundingClientRect();
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) {
        return { x: innerWidth / 2, y: innerHeight / 2 };
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const burst = () => {
    const { x, y } = burstOrigin();
    const at = (delayMs: number) => `left:${x}px;top:${y}px;animation-delay:${delayMs}ms`;
    const rings = Array.from({ length: RING_COUNT }, (_, i) => h("span", { class: `ring ring-${i}`, style: at(i * RING_STAGGER_MS) }));
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => {
        const angle = Math.random() * FULL_TURN;
        const distance = SHARD_MIN_PX + Math.random() * SHARD_SPREAD_PX;
        return h(
            "span",
            {
                class: `shard ${i % 2 ? "magenta" : "cyan"}`,
                style: `${at(Math.random() * SHARD_DELAY_MS)};--dx:${Math.cos(angle) * distance}px;--dy:${Math.sin(angle) * distance}px`,
            },
            randomGlyph(),
        );
    });
    const layer = h("div", { class: "fx-layer", "aria-hidden": "true" }, rings, shards);
    document.body.append(layer);
    setTimeout(() => layer.remove(), BURST_MS);
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

const showToast = (pr: MergedPr, animate: boolean) => {
    const head = h("b", { class: "toast-head" });
    const title = h("span", { class: "toast-title" });
    const toast = h("a", { class: "toast", href: pr.url, rel: "noopener" }, head, title);
    const heading = `▲ MERGED #${pr.number}`;
    if (animate) {
        glitchType(head, heading);
        glitchType(title, pr.title);
    } else {
        head.textContent = heading;
        title.textContent = pr.title;
    }
    toastStack().append(toast);
    setTimeout(() => toast.classList.add("out"), TOAST_MS);
    setTimeout(() => toast.remove(), TOAST_MS + TOAST_OUT_MS);
};

export const celebrateMerge = (pr: MergedPr) => {
    const animate = !motionReduced();
    showToast(pr, animate);
    if (animate) {
        burst();
        dispatchEvent(new CustomEvent("rain-surge"));
    }
};
