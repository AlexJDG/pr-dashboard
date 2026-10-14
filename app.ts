import { startBoot } from "./boot.ts";
import { CHART_W, lineChart } from "./chart.ts";
import { h } from "./dom.ts";
import { ago, clockTime, compactDuration, quotePlus } from "./format.ts";
import { celebrateMerges } from "./fx.ts";
import { mountFxMenu } from "./fxmenu.ts";
import type { DashboardData, Label, PrRow, Stats, Tab } from "./types.ts";

const MS_PER_SECOND = 1000;
const VERSION_POLL_MS = 1000;
const DEFAULT_TAB = "queue";
const DEFAULT_LABEL_COLOR = "888888";
const HEX_COLOUR = /^[0-9a-fA-F]{6}$/;
const PERCENT = 100;
const TOOLTIP_OFFSET = 12;
const DEFAULT_REFRESH_SECONDS = 15;
const DATA_TIMEOUT_MS = 60 * 1000;
const DEFAULT_STATS_DAYS = 7;
const STATS_DAYS_KEY = "statsDays";
const MIN_STREAK_DAYS = 2;
const NO_VALUE = "-";

const pie = document.querySelector<HTMLElement>(".pie");
const loadedVersion = document.querySelector<HTMLMetaElement>("meta[name=version]")?.content ?? null;
let hasRendered = false;
let refreshSeconds = DEFAULT_REFRESH_SECONDS;
let lastData: DashboardData | null = null;
let seenMerges: Set<number> | null = null;
let seedMergedAt = "";
const provideBootData = startBoot();

const storedStatsDays = () => {
    try {
        return Number(localStorage.getItem(STATS_DAYS_KEY)) || DEFAULT_STATS_DAYS;
    } catch {
        return DEFAULT_STATS_DAYS;
    }
};

let statsDays = storedStatsDays();

const labelStyle = (colour: string) => {
    const safe = HEX_COLOUR.test(colour) ? colour : DEFAULT_LABEL_COLOR;
    return `background:#${safe}33;border-color:#${safe}`;
};

const pill = (label: Label) => [" ", h("span", { class: "label", style: labelStyle(label.color) }, label.name)];

// The link wraps the whole row so hovering anywhere shows its URL; display: contents keeps the table layout
const tableRow = (pr: PrRow, i: number, kodiak: boolean) =>
    h(
        "a",
        { class: "row", href: pr.url, rel: "noopener" },
        h(
            "tr",
            { style: `--i:${i}`, class: kodiak && pr.blocked ? "blocked" : undefined },
            h("td", {}, h("span", { class: "num" }, `#${pr.number}`)),
            h(
                "td",
                {},
                pr.title,
                pr.labels.flatMap(pill),
                pr.unresolved ? [" ", h("span", { class: "unresolved" }, `${pr.unresolved} unresolved`)] : null,
            ),
            h(
                "td",
                { class: "diff" },
                h("span", { class: "add" }, `+${pr.additions.toLocaleString("en-US")}`),
                " ",
                h("span", { class: "del" }, `-${pr.deletions.toLocaleString("en-US")}`),
            ),
            h("td", {}, pr.author),
            h("td", { class: "age", title: `Opened ${pr.createdAt}, updated ${pr.updatedAt}` }, `${ago(pr.createdAt)} / ${ago(pr.updatedAt)}`),
            kodiak ? h("td", {}, pr.kodiak) : null,
        ),
    );

const table = (tab: Tab) => {
    const kodiak = tab.key === "queue";
    const rows = tab.prs.length
        ? tab.prs.map((pr, i) => tableRow(pr, i, kodiak))
        : [h("tr", {}, h("td", { colspan: kodiak ? 6 : 5, class: "muted" }, "None"))];
    return h(
        "table",
        {},
        h(
            "thead",
            {},
            h(
                "tr",
                {},
                ["PR", "Title", "Lines", "Author", "Opened / updated"].map((heading) => h("th", {}, heading)),
                kodiak ? h("th", {}, "Kodiak") : null,
            ),
        ),
        h("tbody", {}, rows),
    );
};

const githubSearchUrl = (repo: string, search: string) => `https://github.com/${repo}/pulls?q=${quotePlus(search)}`;

// Rendered already "on" so a redraw doesn't replay the glow transition
const tile = (tab: Tab, loaded: boolean, active: string) =>
    h(
        "button",
        { class: tab.key === active ? "tile on" : "tile", "data-tab": tab.key },
        h("span", { class: "tile-label" }, tab.label),
        h(
            "span",
            { class: "big" },
            loaded ? `${tab.count}` : "?",
            loaded && tab.blocked ? h("small", {}, `${tab.blocked} blocked`) : null,
        ),
    );

const panel = (tab: Tab, repo: string) =>
    h(
        "section",
        { id: tab.key, hidden: true },
        h(
            "h2",
            {},
            tab.label,
            tab.search === null ? null : [" ", h("a", { class: "gh", href: githubSearchUrl(repo, `is:pr ${tab.search}`) }, "view on GitHub")],
        ),
        table(tab),
    );

const statsPanel = (repo: string, stats: Stats | null) => {
    if (!stats) {
        return null;
    }
    const selected = stats.windows.find((w) => w.days === statsDays) ?? stats.windows.find((w) => w.days === DEFAULT_STATS_DAYS) ?? stats.windows[0];
    if (!selected) {
        return null;
    }
    const period = selected.days === 1 ? "today" : `last ${selected.days} days`;
    const top = Math.max(1, ...selected.reviews.map((review) => review.count));
    const bars = selected.reviews.map(({ login, count }) => {
        const isTop = count === selected.reviews[0]?.count;
        const leaderStreak = isTop ? selected.leaderStreaks[login] : undefined;
        const leaderDays = leaderStreak?.days ?? 0;
        const hasStreak = leaderDays >= MIN_STREAK_DAYS;
        const leaderNote = `top reviewer for ${leaderDays}${leaderStreak?.capped ? "+" : ""} working days running`;
        return h(
            "div",
            {
                class: "bar-row",
                title: `${login} reviewed ${count} PR${count === 1 ? "" : "s"} in the ${period}${hasStreak ? `, ${leaderNote}` : ""}`,
            },
            h(
                "span",
                { class: "bar-name" },
                h("span", { class: "bar-login" }, login),
                isTop
                    ? h("span", { class: "crown", role: "img", "aria-label": hasStreak ? `Top reviewer, ${leaderNote}` : "Top reviewer" }, hasStreak ? `♛ ${leaderDays}d${leaderStreak?.capped ? "+" : ""}` : "♛")
                    : null,
            ),
            h("span", { class: "bar-track" }, h("span", { class: "bar", style: `width:${((count / top) * PERCENT).toFixed(1)}%` })),
            h("span", { class: "bar-value" }, `${count}`),
        );
    });
    return h(
        "div",
        { class: "stats" },
        h(
            "h2",
            {},
            "Stats",
            h(
                "span",
                { class: "range", role: "group", "aria-label": "Stats period" },
                stats.windows.map((w) =>
                    h("button", { type: "button", "data-stats-days": w.days, "aria-pressed": String(w === selected) }, `${w.days}d`),
                ),
            ),
        ),
        h(
            "div",
            { class: "stats-grid" },
            h(
                "div",
                { class: "stat-column" },
                h(
                    "a",
                    { class: "tile stat", href: githubSearchUrl(repo, selected.mergedSearch) },
                    h("span", { class: "tile-label" }, `Merged, ${period}`),
                    h("span", { class: "big" }, `${selected.merged}`),
                ),
                h(
                    "div",
                    { class: "tile median" },
                    h("span", { class: "tile-label" }, `Median time to merge, ${period}`),
                    h("span", { class: "big" }, selected.medianMergeMs === null ? NO_VALUE : compactDuration(selected.medianMergeMs)),
                ),
            ),
            h(
                "div",
                { class: "tile reviews" },
                h("span", { class: "tile-label" }, `PRs reviewed by dev, ${period}`),
                bars.length ? bars : h("p", { class: "muted" }, "No reviews"),
            ),
        ),
        lineChart(stats),
    );
};

const renderMain = (data: DashboardData) =>
    h(
        "main",
        {},
        h(
            "header",
            {},
            h("h1", {}, h("span", { class: "prompt" }, ">"), ` ${data.repo}`, h("span", { class: "dim" }, "/pulls"), h("span", { class: "cursor" }, "_")),
        ),
        h("div", { class: "tiles" }, data.tabs.map((tab) => tile(tab, data.loaded, location.hash.slice(1) || DEFAULT_TAB))),
        data.error ? h("pre", { class: "err" }, data.error) : null,
        h("div", { class: "panels" }, data.tabs.map((tab) => panel(tab, data.repo))),
        statsPanel(data.repo, data.stats),
        h(
            "footer",
            { class: "muted" },
            data.rate
                ? `[gh api] ${data.rate.remaining.toLocaleString("en-US")}/${data.rate.limit.toLocaleString("en-US")} left · resets ${clockTime(data.rate.resetAt)} · cost ${data.rate.cost}/refresh`
                : "",
        ),
    );

// Transitions an element from its old height to its new one; its CSS supplies the height transition
const animateHeight = (element: HTMLElement, from: number) => {
    const to = element.scrollHeight;
    if (from === 0 || from === to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
    }
    element.style.height = `${from}px`;
    void element.offsetHeight; // commit the start height before transitioning
    element.style.height = `${to}px`;
    const done = (e: TransitionEvent) => {
        if (e.target !== element) {
            return;
        }
        element.style.height = "";
        element.removeEventListener("transitionend", done);
    };
    element.addEventListener("transitionend", done);
};

const show = (requested: string, animate = false) => {
    const panels = document.querySelector<HTMLElement>(".panels");
    if (!panels) {
        return;
    }
    const key = document.querySelector(`section[id="${CSS.escape(requested)}"]`) ? requested : DEFAULT_TAB;
    const from = panels.offsetHeight;
    document.querySelectorAll("section").forEach((section) => {
        section.hidden = section.id !== key;
        section.classList.toggle("enter", animate && section.id === key);
    });
    document.querySelectorAll<HTMLElement>(".tile[data-tab]").forEach((t) => t.classList.toggle("on", t.dataset.tab === key));
    history.replaceState(null, "", `#${key}`);
    if (animate) {
        animateHeight(panels, from);
    }
};

const tileCounts = () =>
    Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>(".tile[data-tab]")].map((t) => [t.dataset.tab, t.querySelector(".big")?.textContent]),
    );

const draw = (data: DashboardData) => {
    const previous = tileCounts();
    const heightOf = (selector: string) => document.querySelector<HTMLElement>(selector)?.offsetHeight ?? 0;
    const panelsFrom = heightOf(".panels");
    const statsFrom = heightOf(".stats-grid");
    const main = renderMain(data);
    document.querySelector("main")?.replaceWith(main);
    main.querySelectorAll<HTMLElement>(".tile[data-tab]").forEach((t) => {
        const before = previous[t.dataset.tab ?? ""];
        if (before !== undefined && before !== t.querySelector(".big")?.textContent) {
            t.classList.add("changed");
        }
    });
    show(location.hash.slice(1), !hasRendered);
    // Rows or reviewers coming and going resize these, so ease them to their new height
    if (hasRendered) {
        const resized: [string, number][] = [
            [".panels", panelsFrom],
            [".stats-grid", statsFrom],
        ];
        resized.forEach(([selector, from]) => {
            const element = main.querySelector<HTMLElement>(selector);
            if (element) {
                animateHeight(element, from);
            }
        });
    }
    hasRendered = true;
};

// The first loaded payload only seeds the seen set and cutoff, so merges from before the page opened don't celebrate.
// The cutoff stays fixed because the list is ordered by last update, not merge time; the seen set stops repeats.
const celebrateNewMerges = (data: DashboardData) => {
    if (!data.loaded) {
        return;
    }
    const seen = seenMerges ?? new Set<number>();
    const fresh = seenMerges
        ? data.recentMerges
              .filter((pr) => pr.mergedAt >= seedMergedAt && !seen.has(pr.number))
              .toSorted((a, b) => a.mergedAt.localeCompare(b.mergedAt))
        : [];
    if (!seenMerges) {
        seedMergedAt = data.recentMerges.reduce((latest, pr) => (pr.mergedAt > latest ? pr.mergedAt : latest), "");
    }
    data.recentMerges.forEach((pr) => seen.add(pr.number));
    seenMerges = seen;
    celebrateMerges(fresh);
};

const restartPie = () => {
    if (!pie) {
        return;
    }
    pie.style.setProperty("--refresh", `${refreshSeconds}s`);
    pie.title = `Refreshes every ${refreshSeconds}s`;
    pie.setAttribute("aria-label", pie.title);
    pie.style.animation = "none";
    void pie.offsetWidth; // restart the fill animation
    pie.style.animation = "";
};

const refresh = async () => {
    document.body.classList.add("loading");
    try {
        const response = await fetch("/data.json", { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Data request failed with status ${response.status}`);
        }
        const data: DashboardData = await response.json();
        refreshSeconds = data.refreshSeconds;
        // new code means new CSS/JS too, which a content swap would miss
        if (loadedVersion !== null && data.version !== loadedVersion) {
            location.reload();
            return;
        }
        lastData = data;
        draw(data);
        celebrateNewMerges(data);
        provideBootData(data.loaded ? data : null);
    } catch {
        provideBootData(null);
        // keep the current view and try again on the next tick
    } finally {
        document.body.classList.remove("loading");
        restartPie();
        setTimeout(refresh, refreshSeconds * MS_PER_SECOND);
    }
};

document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) {
        return;
    }
    const tab = e.target.closest<HTMLElement>(".tile[data-tab]");
    if (tab) {
        show(tab.dataset.tab ?? DEFAULT_TAB, true);
    }
    const range = e.target.closest<HTMLElement>("[data-stats-days]");
    if (range && lastData) {
        statsDays = Number(range.dataset.statsDays);
        try {
            localStorage.setItem(STATS_DAYS_KEY, String(statsDays));
        } catch {
            // the choice just won't survive a reload
        }
        // Swap only the stats so the tiles above don't replay their animations
        const current = document.querySelector<HTMLElement>(".stats");
        const next = statsPanel(lastData.repo, lastData.stats);
        const from = current?.querySelector<HTMLElement>(".stats-grid")?.offsetHeight ?? 0;
        current?.replaceWith(next ?? "");
        const grid = next?.querySelector<HTMLElement>(".stats-grid");
        if (grid) {
            animateHeight(grid, from);
        }
    }
});

document.addEventListener("mouseover", (e) => {
    if (!(e.target instanceof Element)) {
        return;
    }
    const chart = e.target.closest<HTMLElement>(".chart");
    if (!chart) {
        return;
    }
    const tip = chart.querySelector<HTMLElement>(".chart-tip");
    const cross = chart.querySelector<SVGLineElement>(".crosshair");
    const svgElement = chart.querySelector("svg");
    if (!tip || !cross || !svgElement) {
        return;
    }
    const hit = e.target.closest<SVGElement>(".hit");
    if (!hit) {
        tip.hidden = true;
        cross.style.opacity = "0";
        return;
    }
    const [day = "", ...values] = (hit.dataset.tip ?? "").split("|");
    tip.replaceChildren(
        h("b", {}, day),
        ...values.map((value) => {
            const [name = "", n = ""] = value.split(":");
            return h("div", {}, h("span", { class: `key s-${name.toLowerCase()}` }), `${name} `, h("b", {}, n));
        }),
    );
    const x = hit.dataset.x ?? "0";
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.style.opacity = "1";
    const px = (Number(x) * svgElement.clientWidth) / CHART_W;
    tip.hidden = false;
    tip.style.left = `${Math.min(px + TOOLTIP_OFFSET, chart.clientWidth - tip.offsetWidth)}px`;
});

document.addEventListener("mouseleave", () => document.querySelectorAll<HTMLElement>(".chart-tip").forEach((t) => (t.hidden = true)));

setInterval(
    () =>
        fetch("/version")
            .then(async (r) => (r.ok ? r.text() : loadedVersion))
            .then((version) => {
                if (loadedVersion !== null && version !== loadedVersion) {
                    location.reload();
                }
            })
            .catch(() => {}),
    VERSION_POLL_MS,
);

mountFxMenu(() => (lastData?.loaded ? lastData : null));
void refresh();
