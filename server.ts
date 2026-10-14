import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { DashboardData, Label, MergedPr, PrRow, RateInfo, Stats, StatsWindow, Tab } from "./types.ts";

const REPO = "owner/repo";
const REFRESH_SECONDS = 15;
const DEFAULT_PORT = 8765;
const PORT = Number(process.argv[2] ?? DEFAULT_PORT);
const MS_PER_SECOND = 1000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const START_TIME = Date.now();
// Exit once no page has polled for this long; > 60s because Chrome throttles hidden pages' timers to once a minute
const IDLE_EXIT_SECONDS = Number(process.env.IDLE_EXIT_SECONDS ?? 0);
const IDLE_CHECK_SECONDS = 5;
const SELF_RESTART = process.env.SELF_RESTART === "1";
const SELF_RESTART_EXIT_CODE = 75;
const SELF_RESTART_POLL_MS = 1000;
const SERVER_FILE = fileURLToPath(import.meta.url);
const MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 30 * 1000;

const KODIAK_APP_ID = 29196;
const RECENT_MERGES_LIMIT = 10;
// First 100 open PRs only; paginate if the repo ever has more
const QUERY = `
query($q: String!, $mergedQ: String!) {
  rateLimit { cost limit remaining resetAt }
  viewer { login }
  merged: search(query: $mergedQ, type: ISSUE, first: ${RECENT_MERGES_LIMIT}) {
    nodes { ... on PullRequest { number title url mergedAt } }
  }
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest {
      number title url createdAt updatedAt additions deletions mergeable reviewDecision author { login }
      reviewThreads(first: 100) { nodes { isResolved } }
      labels(first: 10) { nodes { name color } }
      commits(last: 1) { nodes { commit {
        statusCheckRollup { state }
        checkSuites(first: 1, filterBy: {appId: ${KODIAK_APP_ID}}) { nodes { checkRuns(last: 1) { nodes { title } } } }
      } } }
    } }
  }
}`;

const STATS_WINDOW_DAYS = [1, 7, 28];
const CHART_DAYS = 14;
const STATS_REFRESH_SECONDS = 300;
const STATS_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number createdAt mergedAt closedAt author { login }
      reviews(first: 100) { nodes { submittedAt author { login __typename } } }
    } }
  }
}`;

const BASE = "is:open draft:false";
const FAILING = `${BASE} status:failure`;
// GitHub leaves reviewDecision blank on some PRs that still need an approval, so exclude the decided ones
// rather than matching review:required; -status:failure so PRs with checks still running count
const NEEDS_REVIEW = `${BASE} -author:@me -review:approved -review:changes_requested -status:failure`;
const QUEUE = `${BASE} label:automerge -label:stacked`;
// Stop polling until the hourly reset rather than drain the budget other gh tools share
const MIN_RATE_REMAINING = 500;
const GHOST_LOGIN = "ghost";
const SUNDAY = 0;
const SATURDAY = 6;
const NO_KODIAK_STATUS = "no Kodiak status";

type RawPr = {
    number: number;
    title: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    additions: number;
    deletions: number;
    mergeable: string;
    reviewDecision: string | null;
    author: { login: string } | null;
    reviewThreads: { nodes: ({ isResolved: boolean } | null)[] };
    labels: { nodes: (Label | null)[] };
    commits: {
        nodes: ({
            commit: {
                statusCheckRollup: { state: string } | null;
                checkSuites: { nodes: ({ checkRuns: { nodes: ({ title: string } | null)[] } } | null)[] };
            };
        } | null)[];
    };
};

type OpenPrsResult = {
    rateLimit: RateInfo;
    viewer: { login: string };
    search: { nodes: RawPr[] };
    merged: { nodes: (MergedPr | null)[] };
};

type Pr = PrRow & { checks: string | undefined; mergeable: string; reviewDecision: string | null };

type StatsPr = {
    number: number;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    author: { login: string } | null;
    reviews: { nodes: ({ submittedAt: string | null; author: { login: string; __typename: string } | null } | null)[] };
};

type StatsResult = {
    search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: (StatsPr | null)[] };
};

const execFileAsync = promisify(execFile);

const errorText = (error: unknown) => {
    if (error instanceof Error && "killed" in error && error.killed) {
        return `gh timed out after ${GH_TIMEOUT_MS / MS_PER_SECOND}s`;
    }
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr) {
        return error.stderr;
    }
    return error instanceof Error ? error.message : String(error);
};

const graphql = async <T>(query: string, variables: Record<string, string> = {}) => {
    const args = Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
    const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`, ...args], {
        maxBuffer: MAX_BUFFER,
        timeout: GH_TIMEOUT_MS,
    });
    const body: { data?: T; errors?: { message: string }[] } = JSON.parse(stdout);
    if (!body.data) {
        throw new Error(body.errors?.map((e) => e.message).join("\n") || "GitHub returned no data");
    }
    return body.data;
};

// 🛑 means Kodiak won't merge it, ⚠️ means Kodiak hit an error and isn't processing it
const isBlockedStatus = (kodiak: string) => kodiak.startsWith("🛑") || kodiak.startsWith("⚠️");

const isBlocked = (pr: PrRow) => isBlockedStatus(pr.kodiak);

const hasLabel = (pr: PrRow, name: string) => pr.labels.some((label) => label.name === name);

const isFailing = (pr: Pr) => pr.checks === "FAILURE" || pr.checks === "ERROR" || pr.unresolved > 0;

const toPr = (raw: RawPr): Pr => {
    const commit = raw.commits.nodes[0]?.commit;
    const kodiakRun = commit?.checkSuites.nodes.flatMap((suite) => suite?.checkRuns.nodes ?? []).find((run) => run !== null);
    const kodiak = kodiakRun?.title ?? NO_KODIAK_STATUS;
    return {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        additions: raw.additions,
        deletions: raw.deletions,
        author: raw.author?.login ?? GHOST_LOGIN,
        labels: raw.labels.nodes.filter((label) => label !== null),
        unresolved: raw.reviewThreads.nodes.filter((thread) => thread && !thread.isResolved).length,
        kodiak,
        blocked: isBlockedStatus(kodiak),
        checks: commit?.statusCheckRollup?.state,
        mergeable: raw.mergeable,
        reviewDecision: raw.reviewDecision,
    };
};

const toRow = ({ checks: _checks, mergeable: _mergeable, reviewDecision: _reviewDecision, ...row }: Pr): PrRow => row;

const isPullRequest = (node: RawPr | null): node is RawPr => typeof node?.number === "number";

const isMergedPr = (node: MergedPr | null): node is MergedPr => typeof node?.number === "number";

const openPrs = async () => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const result = await graphql<OpenPrsResult>(QUERY, {
        q: `repo:${REPO} is:pr ${BASE}`,
        mergedQ: `repo:${REPO} is:pr is:merged merged:>=${searchTimestamp(midnight)} sort:updated-desc`,
    });
    return {
        prs: result.search.nodes.filter(isPullRequest).map(toPr),
        merges: result.merged.nodes.filter(isMergedPr),
        rate: result.rateLimit,
        me: result.viewer.login,
    };
};

const fetchRateLimit = async () => (await graphql<{ rateLimit: RateInfo }>("{ rateLimit { cost limit remaining resetAt } }")).rateLimit;

const pad2 = (n: number) => String(n).padStart(2, "0");

const localDay = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const clockTime = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

// GitHub search accepts whole-second UTC timestamps, which also compare correctly as strings against its own
const searchTimestamp = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

// People only, not bots or the PR author replying on their own PR
const countedReviews = (pr: StatsPr) =>
    pr.reviews.nodes.flatMap((review) => {
        const reviewer = review?.author;
        if (!review?.submittedAt || !reviewer || reviewer.__typename !== "User" || reviewer.login === pr.author?.login) {
            return [];
        }
        return [{ login: reviewer.login, submittedAt: review.submittedAt }];
    });

const median = (values: number[]) => {
    if (values.length === 0) {
        return null;
    }
    const sorted = values.toSorted((a, b) => a - b);
    const lower = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
    const upper = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return (lower + upper) / 2;
};

const isWeekend = (date: Date) => date.getDay() === SUNDAY || date.getDay() === SATURDAY;

const previousWorkingDay = (date: Date): Date => {
    const previous = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    return isWeekend(previous) ? previousWorkingDay(previous) : previous;
};

// Consecutive working days with a review, ending today or the previous working day; weekends neither count nor break it
const streakLength = (reviewDays: Set<string>, today: Date, oldest: Date) => {
    const latest = isWeekend(today) ? previousWorkingDay(today) : today;
    let day = reviewDays.has(localDay(latest)) ? latest : previousWorkingDay(latest);
    let length = 0;
    while (day >= oldest && reviewDays.has(localDay(day))) {
        length++;
        day = previousWorkingDay(day);
    }
    return length;
};

const reviewStreaks = (prs: StatsPr[], now: Date, fetchDays: number) => {
    const reviewDays = new Map<string, Set<string>>();
    prs.flatMap(countedReviews).forEach(({ login, submittedAt }) => {
        reviewDays.set(login, (reviewDays.get(login) ?? new Set()).add(localDay(new Date(submittedAt))));
    });
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (fetchDays - 1));
    return Object.fromEntries(
        [...reviewDays]
            .map(([login, days]) => [login, streakLength(days, today, oldest)] as const)
            .filter(([, length]) => length > 0),
    );
};

// Calendar days including today, so the 1 day window matches today's point on the chart
const windowStats = (prs: StatsPr[], days: number, now: Date): StatsWindow => {
    const since = searchTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
    const reviewed = new Map<string, Set<number>>();
    for (const pr of prs) {
        for (const { login, submittedAt } of countedReviews(pr)) {
            if (submittedAt >= since) {
                reviewed.set(login, (reviewed.get(login) ?? new Set()).add(pr.number));
            }
        }
    }
    const mergedInWindow = prs.filter((pr) => pr.mergedAt && pr.mergedAt >= since);
    return {
        days,
        merged: mergedInWindow.length,
        medianMergeMs: median(mergedInWindow.map((pr) => Date.parse(pr.mergedAt ?? "") - Date.parse(pr.createdAt))),
        mergedSearch: `repo:${REPO} is:pr is:merged merged:>=${since}`,
        reviews: [...reviewed]
            .map(([login, numbers]) => ({ login, count: numbers.size }))
            .sort((a, b) => b.count - a.count || compareStrings(a.login.toLowerCase(), b.login.toLowerCase())),
    };
};

const reviewStats = async (): Promise<Stats> => {
    const now = new Date();
    const dayOffset = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const days = Array.from({ length: CHART_DAYS }, (_, i) => localDay(dayOffset(i - (CHART_DAYS - 1))));
    const fetchDays = Math.max(CHART_DAYS, ...STATS_WINDOW_DAYS);
    const variables: Record<string, string> = { q: `repo:${REPO} is:pr updated:>=${localDay(dayOffset(-fetchDays))}` };
    const prs: StatsPr[] = [];
    while (true) {
        const result = await graphql<StatsResult>(STATS_QUERY, variables);
        prs.push(...result.search.nodes.filter((pr): pr is StatsPr => typeof pr?.number === "number"));
        if (!result.search.pageInfo.hasNextPage) {
            break;
        }
        variables.after = result.search.pageInfo.endCursor;
    }
    const tally = (dates: string[]) => days.map((day) => dates.filter((date) => date === day).length);
    return {
        windows: STATS_WINDOW_DAYS.map((windowDays) => windowStats(prs, windowDays, now)),
        days,
        streaks: reviewStreaks(prs, now, fetchDays),
        series: [
            { name: "Opened", values: tally(prs.map((pr) => localDay(new Date(pr.createdAt)))) },
            { name: "Merged", values: tally(prs.flatMap((pr) => (pr.mergedAt ? [localDay(new Date(pr.mergedAt))] : []))) },
            {
                name: "Closed",
                values: tally(prs.flatMap((pr) => (pr.closedAt && !pr.mergedAt ? [localDay(new Date(pr.closedAt))] : []))),
            },
        ],
    };
};

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Categorised = { open: Pr[]; failing: Pr[]; needsReview: Pr[]; automerge: Pr[] };

const categorise = (prs: Pr[], me: string): Categorised => {
    const open = prs.toSorted((a, b) => compareStrings(b.updatedAt, a.updatedAt));
    const automerge = open
        .filter((pr) => hasLabel(pr, "automerge") && !hasLabel(pr, "stacked"))
        // queued first, then mirrors Kodiak's ordering: hotfix first, then oldest
        .sort(
            (a, b) =>
                Number(isBlocked(a)) - Number(isBlocked(b)) ||
                Number(!hasLabel(a, "hotfix")) - Number(!hasLabel(b, "hotfix")) ||
                compareStrings(a.createdAt, b.createdAt),
        );
    return {
        open,
        // main requires review threads resolved before merging, so unresolved comments block like a failing check
        failing: open.filter(isFailing),
        needsReview: open.filter(
            (pr) =>
                pr.author !== me &&
                pr.reviewDecision !== "APPROVED" &&
                pr.reviewDecision !== "CHANGES_REQUESTED" &&
                !isFailing(pr) &&
                pr.mergeable !== "CONFLICTING",
        ),
        automerge,
    };
};

let categorised: Categorised | null = null;
let error = "";
let nextFetch = 0;
let rate: RateInfo | null = null;
let viewer = "";
let recentMerges: MergedPr[] = [];
let stats: Stats | null = null;
let nextStats = 0;
let inFlight: Promise<void> | null = null;
let lastPoll = performance.now();

const resetTime = (info: RateInfo) => new Date(info.resetAt);

// Wall-clock moment as a point on the monotonic clock
const monotonicAt = (moment: Date) => performance.now() + (moment.getTime() - Date.now());

const refreshFromGithub = async () => {
    nextFetch = performance.now() + (REFRESH_SECONDS - 1) * MS_PER_SECOND;
    let result: Awaited<ReturnType<typeof openPrs>>;
    try {
        result = await openPrs();
    } catch (e) {
        error = errorText(e);
        if (!error.includes("rate limit")) {
            return;
        }
        try {
            rate = await fetchRateLimit();
        } catch {
            return;
        }
        nextFetch = monotonicAt(resetTime(rate));
        error = `GitHub API rate limit hit, pausing until ${clockTime(resetTime(rate))}`;
        return;
    }
    rate = result.rate;
    error = "";
    if (performance.now() >= nextStats) {
        nextStats = performance.now() + STATS_REFRESH_SECONDS * MS_PER_SECOND;
        try {
            stats = await reviewStats();
        } catch (e) {
            error = errorText(e);
        }
    }
    if (rate.remaining < MIN_RATE_REMAINING) {
        const reset = resetTime(rate);
        nextFetch = monotonicAt(reset);
        error = `GitHub API budget low (${rate.remaining} left), pausing until ${clockTime(reset)}`;
    }
    viewer = result.me;
    recentMerges = result.merges;
    categorised = categorise(result.prs, result.me);
};

// One GitHub query per refresh interval, shared by every open page; keeps the last good data on failure
const fetchDashboard = async () => {
    if (inFlight) {
        return inFlight;
    }
    if (performance.now() < nextFetch) {
        return;
    }
    inFlight = refreshFromGithub().finally(() => {
        inFlight = null;
    });
    return inFlight;
};

const buildTabs = (): Tab[] => {
    const { open, failing, needsReview, automerge } = categorised ?? { open: [], failing: [], needsReview: [], automerge: [] };
    const conflicts = open.filter((pr) => pr.mergeable === "CONFLICTING");
    const queued = automerge.filter((pr) => !isBlocked(pr));
    const accountedFor = new Set([...failing, ...needsReview, ...conflicts, ...queued].map((pr) => pr.number));
    const tab = (key: Tab["key"], label: string, prs: Pr[], search: string | null): Tab => {
        const blocked = key === "queue" ? prs.filter(isBlocked).length : 0;
        return { key, label, search, prs: prs.map(toRow), count: prs.length - blocked, blocked };
    };
    return [
        tab("queue", "In merge queue", automerge, QUEUE),
        tab("open", "Non-draft", open, BASE),
        tab("failing", "Failing checks", failing, FAILING),
        tab("conflicts", "Merge conflicts", conflicts, null),
        tab("review", "Awaiting review", needsReview, NEEDS_REVIEW),
        tab("other", "Other", open.filter((pr) => !accountedFor.has(pr.number)), null),
    ];
};

const CLIENT_FILES = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8", strip: false }],
    ["/style.css", { file: "style.css", type: "text/css; charset=utf-8", strip: false }],
    ...["app.ts", "bg.ts", "boot.ts", "chart.ts", "dom.ts", "format.ts", "fx.ts", "glyphs.ts", "types.ts"].map(
        (file) => [`/${file}`, { file, type: "text/javascript; charset=utf-8", strip: true }] as const,
    ),
]);

const clientVersion = () => {
    const mtimes = [...CLIENT_FILES.values()].flatMap(({ file }) => {
        try {
            return [statSync(path.join(ROOT, file)).mtimeMs];
        } catch {
            return []; // mid-save
        }
    });
    return `${Math.max(0, ...mtimes)}-${START_TIME}`;
};

const dashboardData = (): DashboardData => ({
    version: clientVersion(),
    repo: REPO,
    refreshSeconds: REFRESH_SECONDS,
    loaded: categorised !== null,
    tabs: buildTabs(),
    error,
    rate,
    stats,
    viewer,
    recentMerges,
});

// Rejects other Host headers so a rebound DNS name can't read PR data through the browser
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// The page reads its version at load, so edits made while the first data fetch is pending still trigger a reload
const withVersion = (html: string, pathname: string) =>
    pathname === "/" ? html.replace("</head>", `    <meta name="version" content="${clientVersion()}">\n</head>`) : html;

const server = createServer(async (req, res) => {
    lastPoll = performance.now();
    const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
        res.end(body);
    };
    try {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
            send(403, "text/plain; charset=utf-8", "Forbidden");
        } else if (req.method !== "GET") {
            send(405, "text/plain; charset=utf-8", "Method not allowed");
        } else if (pathname === "/version") {
            send(200, "text/plain; charset=utf-8", clientVersion());
        } else if (pathname === "/data.json") {
            await fetchDashboard();
            send(200, "application/json; charset=utf-8", JSON.stringify(dashboardData()));
        } else {
            const client = CLIENT_FILES.get(pathname);
            if (!client) {
                send(404, "text/plain; charset=utf-8", "Not found");
            } else {
                const source = readFileSync(path.join(ROOT, client.file), "utf8");
                send(200, client.type, client.strip ? stripTypeScriptTypes(source) : withVersion(source, pathname));
            }
        }
        if (pathname !== "/version") {
            console.error(`${req.socket.remoteAddress} "${req.method} ${pathname}" ${res.statusCode}`);
        }
    } catch (e) {
        console.error(e);
        send(500, "text/plain; charset=utf-8", "Internal server error");
    }
});

const exitWhenIdle = () => {
    setInterval(() => {
        if (performance.now() - lastPoll >= IDLE_EXIT_SECONDS * MS_PER_SECOND) {
            process.exit(0);
        }
    }, IDLE_CHECK_SECONDS * MS_PER_SECOND);
};

// `node --check` skips ES module .ts files, so check the type-stripped output as a temporary .mjs
const assertValidSyntax = async (file: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pr-dashboard-"));
    try {
        const stripped = path.join(dir, "server.mjs");
        writeFileSync(stripped, stripTypeScriptTypes(readFileSync(file, "utf8")));
        await execFileAsync(process.execPath, ["--check", stripped]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// Exit with a code the launcher treats as "restart me" once server.ts changes and still parses
const restartOnChange = () => {
    let checkedMtime = statSync(SERVER_FILE).mtimeMs;
    setInterval(async () => {
        let mtime: number;
        try {
            mtime = statSync(SERVER_FILE).mtimeMs;
        } catch {
            return; // file briefly missing mid-save or branch switch
        }
        if (mtime === checkedMtime) {
            return;
        }
        checkedMtime = mtime;
        try {
            await assertValidSyntax(SERVER_FILE);
        } catch (e) {
            console.error(`Not reloading, syntax error: ${errorText(e)}`);
            return;
        }
        process.exit(SELF_RESTART_EXIT_CODE);
    }, SELF_RESTART_POLL_MS);
};

if (SELF_RESTART) {
    restartOnChange();
}
if (IDLE_EXIT_SECONDS) {
    exitWhenIdle();
}
server.listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
