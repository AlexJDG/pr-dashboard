const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const AGE_UNITS = [
    ["d", SECONDS_PER_DAY],
    ["h", SECONDS_PER_HOUR],
    ["m", SECONDS_PER_MINUTE],
] as const;
const DURATION_UNITS = [
    ["d", SECONDS_PER_DAY / SECONDS_PER_MINUTE],
    ["h", SECONDS_PER_HOUR / SECONDS_PER_MINUTE],
    ["m", 1],
] as const;
const DURATION_PARTS = 2;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const ago = (iso: string) => {
    const seconds = (Date.now() - Date.parse(iso)) / MS_PER_SECOND;
    const unit = AGE_UNITS.find(([, size]) => seconds >= size);
    return unit ? `${Math.floor(seconds / unit[1])}${unit[0]}` : "now";
};

// The two largest non-zero units, e.g. "2d 4h", "5h 12m", "45m"
export const compactDuration = (ms: number) => {
    let remaining = Math.floor(ms / MS_PER_MINUTE);
    const first = DURATION_UNITS.findIndex(([, size]) => remaining >= size);
    if (first === -1) {
        return "0m";
    }
    return DURATION_UNITS.slice(first, first + DURATION_PARTS)
        .flatMap(([unit, size]) => {
            const amount = Math.floor(remaining / size);
            remaining -= amount * size;
            return amount ? [`${amount}${unit}`] : [];
        })
        .join(" ");
};

export const clockTime = (iso: string) => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// Matches Python's urllib.parse.quote_plus
export const quotePlus = (text: string) =>
    encodeURIComponent(text)
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, "+");

const parseDay = (isoDay: string) => {
    const [year = 0, month = 1, day = 1] = isoDay.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
};

export const dayMonth = (isoDay: string) => {
    const date = parseDay(isoDay);
    return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]}`;
};

export const weekdayDayMonth = (isoDay: string) => `${WEEKDAYS[parseDay(isoDay).getUTCDay()]} ${dayMonth(isoDay)}`;
