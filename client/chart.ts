import { h, pulseStyle, svg } from "./dom.ts";
import { dayMonth, weekdayDayMonth } from "./format.ts";
import type { SeriesName, Stats } from "../shared/types.ts";

const SERIES_CLASS: Record<SeriesName, string> = { Opened: "s-opened", Merged: "s-merged", Closed: "s-closed" };
export const CHART_W = 1000;
const CHART_H = 240;
const PAD = { top: 12, right: 110, bottom: 28, left: 36 };
const GRID_STEPS = 4;
const LABEL_GAP = 16;
const AXIS_LABEL_OFFSET = 8;
const AXIS_TEXT_DROP = 4;
const DOT_RADIUS = 4;
// The flow dash lengths in style.css are percentages of the line
const FLOW_PATH_LENGTH = 100;
const LEADER_START = 6;
const LEADER_END = 18;
const LABEL_X = 22;

const niceMax = (n: number) => Math.max(1, Math.ceil(n / GRID_STEPS)) * GRID_STEPS;

const fixed = (n: number) => n.toFixed(1);

export const lineChart = ({ days, series }: Pick<Stats, "days" | "series">) => {
    const plotW = CHART_W - PAD.left - PAD.right;
    const plotH = CHART_H - PAD.top - PAD.bottom;
    const top = niceMax(Math.max(...series.flatMap((s) => s.values)));
    const x = (i: number) => PAD.left + (plotW * i) / (days.length - 1);
    const y = (v: number) => PAD.top + plotH * (1 - v / top);
    const step = plotW / (days.length - 1);

    const grid = Array.from({ length: GRID_STEPS + 1 }, (_, i) => (i * top) / GRID_STEPS).flatMap((v) => [
        svg("line", { class: "grid", x1: PAD.left, x2: PAD.left + plotW, y1: fixed(y(v)), y2: fixed(y(v)) }),
        svg("text", { class: "axis", x: PAD.left - AXIS_LABEL_OFFSET, y: fixed(y(v) + AXIS_TEXT_DROP), "text-anchor": "end" }, String(v)),
    ]);
    const xLabels = days.flatMap((day, i) =>
        i % 2 === (days.length - 1) % 2
            ? [svg("text", { class: "axis", x: fixed(x(i)), y: CHART_H - AXIS_LABEL_OFFSET, "text-anchor": "middle" }, dayMonth(day))]
            : [],
    );
    const pointsOf = (values: number[]) => values.map((v, i) => `${fixed(x(i))},${fixed(y(v))}`).join(" ");
    const lines = series.flatMap(({ name, values }) => [
        svg("polyline", { class: `line ${SERIES_CLASS[name]}`, points: pointsOf(values) }),
        ...values.map((v, i) => svg("circle", { class: `dot ${SERIES_CLASS[name]}`, cx: fixed(x(i)), cy: fixed(y(v)), r: DOT_RADIUS })),
    ]);
    const layer = (className: string, style: string, ...children: SVGElement[]) =>
        h("div", { class: `chart-layer ${className}`, style, "aria-hidden": "true" }, svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}` }, children));
    const glows = series.map(({ name, values }) =>
        layer("pulse", pulseStyle(name), svg("polyline", { class: `glow ${SERIES_CLASS[name]}`, points: pointsOf(values) })),
    );
    const flows = layer(
        "flows",
        "",
        ...series.map(({ name, values }) =>
            svg("polyline", { class: `flow ${SERIES_CLASS[name]}`, points: pointsOf(values), pathLength: FLOW_PATH_LENGTH, style: pulseStyle(`${name} flow`) }),
        ),
    );

    // end labels sorted top to bottom and pushed apart so they never overlap; a leader line joins each to its line
    const ends = series
        .map(({ name, values }) => ({ lineY: y(values.at(-1) ?? 0), name, value: values.at(-1) ?? 0 }))
        .sort((a, b) => a.lineY - b.lineY || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.value - b.value);
    const placed = ends.reduce<((typeof ends)[number] & { labelY: number })[]>((done, end) => {
        const previous = done.at(-1);
        return [...done, { ...end, labelY: previous ? Math.max(end.lineY, previous.labelY + LABEL_GAP) : end.lineY }];
    }, []);
    const endX = x(days.length - 1);
    const endLabels = placed.flatMap(({ lineY, labelY, name, value }) => [
        svg("line", {
            class: `leader ${SERIES_CLASS[name]}`,
            x1: fixed(endX + LEADER_START),
            y1: fixed(lineY),
            x2: fixed(endX + LEADER_END),
            y2: fixed(labelY),
        }),
        svg("text", { class: "end-label", x: fixed(endX + LABEL_X), y: fixed(labelY + AXIS_TEXT_DROP) }, `${name} ${value}`),
    ]);

    const hits = days.map((day, i) =>
        svg("rect", {
            class: "hit",
            x: fixed(x(i) - step / 2),
            y: PAD.top,
            width: fixed(step),
            height: plotH,
            "data-x": fixed(x(i)),
            "data-tip": [weekdayDayMonth(day), ...series.map(({ name, values }) => `${name}:${values[i]}`)].join("|"),
        }),
    );

    const legend = series.map(({ name }) =>
        h("span", { class: "legend-item" }, h("span", { class: `key ${SERIES_CLASS[name]}` }), name),
    );
    const tableRows = days.map((day, i) =>
        h("tr", {}, h("td", {}, weekdayDayMonth(day)), series.map(({ values }) => h("td", {}, String(values[i])))),
    );

    return h(
        "div",
        { class: "tile chart-tile" },
        h(
            "div",
            { class: "chart-head" },
            h("span", { class: "tile-label" }, `PRs per day, last ${days.length} days`),
            h("span", { class: "legend" }, legend),
        ),
        h(
            "div",
            { class: "chart" },
            svg(
                "svg",
                { viewBox: `0 0 ${CHART_W} ${CHART_H}`, role: "img", "aria-label": "Opened, merged and closed PRs per day" },
                grid,
                xLabels,
                lines,
                endLabels,
                svg("line", { class: "crosshair", x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + plotH }),
                hits,
            ),
            glows,
            flows,
            h("div", { class: "chart-tip", hidden: true }),
        ),
        h(
            "details",
            {},
            h("summary", { class: "muted" }, "Table"),
            h(
                "table",
                {},
                h("thead", {}, h("tr", {}, h("th", {}, "Day"), series.map(({ name }) => h("th", {}, name)))),
                h("tbody", {}, tableRows),
            ),
        ),
    );
};
