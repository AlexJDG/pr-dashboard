const SUNDAY = 0;
const SATURDAY = 6;

export type DatedReview = { login: string; prNumber: number; day: string };

const pad2 = (n: number) => String(n).padStart(2, "0");

export const localDay = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const shiftDays = (date: Date, offset: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);

const isWeekend = (date: Date) => date.getDay() === SUNDAY || date.getDay() === SATURDAY;

const previousWorkingDay = (date: Date): Date => {
    const previous = shiftDays(date, -1);
    return isWeekend(previous) ? previousWorkingDay(previous) : previous;
};

// Everyone tied for the most distinct reviewed PRs in the window of calendar days ending on `day`
const leadersOn = (reviews: DatedReview[], windowDays: number, day: Date) => {
    const from = localDay(shiftDays(day, 1 - windowDays));
    const to = localDay(day);
    const reviewed = new Map<string, Set<number>>();
    reviews
        .filter((review) => review.day >= from && review.day <= to)
        .forEach(({ login, prNumber }) => reviewed.set(login, (reviewed.get(login) ?? new Set()).add(prNumber)));
    const top = Math.max(0, ...[...reviewed.values()].map((prNumbers) => prNumbers.size));
    return new Set([...reviewed].filter(([, prNumbers]) => top > 0 && prNumbers.size === top).map(([login]) => login));
};

// For each current leader, the working days in a row they have led the window ending that day, back from today
// (or the last working day on a weekend). Weekends neither count nor break a run; it stops where the data does.
export const leaderStreaks = (reviews: DatedReview[], windowDays: number, now: Date, fetchDays: number) => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const latest = isWeekend(today) ? previousWorkingDay(today) : today;
    // The window ending on the earliest day we can judge must still lie inside the fetched range
    const earliest = localDay(shiftDays(today, windowDays - fetchDays));
    const streak = (login: string) => {
        let length = 0;
        for (let day = latest; localDay(day) >= earliest && leadersOn(reviews, windowDays, day).has(login); day = previousWorkingDay(day)) {
            length++;
        }
        return length;
    };
    return Object.fromEntries([...leadersOn(reviews, windowDays, latest)].map((login) => [login, streak(login)]));
};
