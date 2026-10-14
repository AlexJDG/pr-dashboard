export type Label = { name: string; color: string };

export type PrRow = {
    number: number;
    title: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    additions: number;
    deletions: number;
    author: string;
    labels: Label[];
    unresolved: number;
    kodiak: string;
    blocked: boolean;
};

export type TabKey = "queue" | "open" | "failing" | "conflicts" | "review" | "other";

export type Tab = {
    key: TabKey;
    label: string;
    search: string | null;
    prs: PrRow[];
    count: number;
    blocked: number;
};

export type RateInfo = { cost: number; limit: number; remaining: number; resetAt: string };

export type SeriesName = "Opened" | "Merged" | "Closed";

export type StatsWindow = {
    days: number;
    merged: number;
    medianMergeMs: number | null;
    mergedSearch: string;
    reviews: { login: string; count: number }[];
    leaderStreaks: Record<string, number>;
};

export type MergedPr = { number: number; title: string; url: string; mergedAt: string };

export type Stats = {
    windows: StatsWindow[];
    days: string[];
    series: { name: SeriesName; values: number[] }[];
};

export type DashboardData = {
    version: string;
    repo: string;
    refreshSeconds: number;
    loaded: boolean;
    tabs: Tab[];
    error: string;
    rate: RateInfo | null;
    stats: Stats | null;
    viewer: string;
    recentMerges: MergedPr[];
};
