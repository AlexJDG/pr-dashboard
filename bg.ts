import { randomGlyph } from "./glyphs.ts";

const GLYPH_PX = 16;
const RAIN_STEP_MS = 70;
const SURGE_STEP_MS = 30;
const SURGE_MS = 2000;
// Chance per step that a drop past the bottom restarts, so columns stay out of sync
const RAIN_RESTART_CHANCE = 0.025;
const RAIN_FADE = 0.12;
const RAIN_COLOUR = "rgba(0, 255, 156, .55)";
const RAIN_HEAD_COLOUR = "#d6ffe9";
const FLOOR_LINE_COLOUR = "rgba(255, 43, 214, .55)";
const FLOOR_LINE_PX = 1.25;
const FLOOR_ROWS = 60;
// Depth of the nearest row; higher packs more rows into the near part of the floor
const FLOOR_NEAR_DEPTH = 5;
// Gap between vertical lines along the bottom edge, as a fraction of the floor width
const FLOOR_COLUMN_SPACING = 0.06;
const FLOOR_SECONDS_PER_ROW = 1.2;
const MS_PER_SECOND = 1000;

const rain = document.querySelector<HTMLCanvasElement>("canvas.rain");
const floor = document.querySelector<HTMLCanvasElement>("canvas.floor");
const rainCtx = rain?.getContext("2d");
const floorCtx = floor?.getContext("2d");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let drops: number[] = [];
let lastRainStep = 0;
let surgeUntil = 0;
let surgeTimer: ReturnType<typeof setTimeout> | undefined;

const fitToScreen = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const scale = devicePixelRatio;
    canvas.width = canvas.clientWidth * scale;
    canvas.height = canvas.clientHeight * scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
};

const resize = () => {
    if (rain && rainCtx) {
        fitToScreen(rain, rainCtx);
        drops = Array.from({ length: Math.ceil(rain.clientWidth / GLYPH_PX) }, () => Math.random() * -rain.clientHeight / GLYPH_PX);
        rainCtx.font = `${GLYPH_PX}px "JetBrains Mono", monospace`;
    }
    if (floor && floorCtx) {
        fitToScreen(floor, floorCtx);
    }
};

const stepRain = (ctx: CanvasRenderingContext2D, height: number) => {
    // Fade old glyphs towards transparent rather than a solid colour, so the page background shows through
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0, 0, 0, ${RAIN_FADE})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.globalCompositeOperation = "source-over";
    drops = drops.map((row, column) => {
        const x = column * GLYPH_PX;
        const y = row * GLYPH_PX;
        ctx.fillStyle = RAIN_COLOUR;
        ctx.fillText(randomGlyph(), x, y - GLYPH_PX);
        ctx.fillStyle = RAIN_HEAD_COLOUR;
        ctx.fillText(randomGlyph(), x, y);
        return y > height && Math.random() < RAIN_RESTART_CHANCE ? 0 : row + 1;
    });
};

// Rows sit at depth z = near, near + 1... and are drawn at y = height * near / z, so they bunch towards the horizon
const drawFloor = (ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number) => {
    const phase = (seconds / FLOOR_SECONDS_PER_ROW) % 1;
    const centre = width / 2;
    const spacing = width * FLOOR_COLUMN_SPACING;
    const fade = ctx.createLinearGradient(0, 0, 0, height);
    fade.addColorStop(0, "transparent");
    fade.addColorStop(1, FLOOR_LINE_COLOUR);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = fade;
    ctx.lineWidth = FLOOR_LINE_PX;
    ctx.beginPath();
    Array.from({ length: FLOOR_ROWS }, (_, row) => (height * FLOOR_NEAR_DEPTH) / (row + FLOOR_NEAR_DEPTH - phase)).forEach((y) => {
        if (y <= height) {
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
        }
    });
    // * 4 so lines far off to the side still reach the visible corners near the horizon
    const columns = Math.ceil(centre / spacing) * 4;
    Array.from({ length: columns * 2 + 1 }, (_, i) => i - columns).forEach((column) => {
        ctx.moveTo(centre, 0);
        ctx.lineTo(centre + column * spacing, height);
    });
    ctx.stroke();
};

const frame = (now: number) => {
    if (rain && rainCtx && now - lastRainStep >= (now < surgeUntil ? SURGE_STEP_MS : RAIN_STEP_MS)) {
        lastRainStep = now;
        stepRain(rainCtx, rain.clientHeight);
    }
    if (floor && floorCtx) {
        drawFloor(floorCtx, floor.clientWidth, floor.clientHeight, now / MS_PER_SECOND);
    }
    if (!reduceMotion) {
        requestAnimationFrame(frame);
    }
};

addEventListener("rain-surge", () => {
    if (!rain || reduceMotion) {
        return;
    }
    surgeUntil = performance.now() + SURGE_MS;
    rain.classList.add("surge");
    clearTimeout(surgeTimer);
    surgeTimer = setTimeout(() => rain.classList.remove("surge"), SURGE_MS);
});

addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);
