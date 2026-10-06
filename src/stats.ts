// Journal statistics: finding symbol entries in notes, dating daily notes
// from their file names, and aggregating both into the numbers the sidebar
// shows. Pure functions only (no Obsidian API), so it's all unit-testable.
import type { SymbolEntry } from "./core";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// Dates are handled as "YYYY-MM-DD" strings (sortable, timezone-free) and
// converted to whole day numbers for arithmetic.
export function dayNumber(date: string): number {
    const [y, m, d] = date.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dateFromDayNumber(n: number): string {
    return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function localToday(now = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// 0 = Monday … 6 = Sunday.
export function weekdayIndex(date: string): number {
    return (dayNumber(date) + 3) % 7; // 1970-01-01 was a Thursday
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatShortDate(date: string, today?: string): string {
    const [y, m, d] = date.split("-").map(Number);
    const base = `${MONTHS[m - 1].slice(0, 3)} ${d}`;
    return today && today.slice(0, 4) === date.slice(0, 4) ? base : `${base}, ${y}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Field = "year" | "year2" | "month" | "monthName" | "day" | "ignore";

// Moment.js-style tokens, longest first so "MMMM" wins over "MM".
const TOKENS: [string, string, Field][] = [
    ["YYYY", "(\\d{4})", "year"],
    ["YY", "(\\d{2})", "year2"],
    ["MMMM", `(${MONTHS.join("|")})`, "monthName"],
    ["MMM", `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`, "monthName"],
    ["MM", "(\\d{2})", "month"],
    ["M", "(\\d{1,2})", "month"],
    ["Do", "(\\d{1,2})(?:st|nd|rd|th)", "day"],
    ["DD", "(\\d{2})", "day"],
    ["D", "(\\d{1,2})", "day"],
    ["dddd", `(${WEEKDAYS.join("|")})`, "ignore"],
    ["ddd", `(${WEEKDAYS.map((d) => d.slice(0, 3)).join("|")})`, "ignore"],
    ["dd", `(${WEEKDAYS.map((d) => d.slice(0, 2)).join("|")})`, "ignore"],
];

// Turns a moment-style date format (the same syntax as Obsidian's Daily
// Notes plugin, e.g. "YYYY-MM-DD" or "[Journal] YYYY-MM-DD ddd") into a
// function that pulls the date out of a note name, returning "YYYY-MM-DD"
// or null when the name doesn't fit the format or isn't a real date.
// Text in [brackets] is matched literally; so is anything that isn't a
// token. Matching is case-insensitive and must cover the whole name.
export function compileDateFormat(format: string): ((name: string) => string | null) | null {
    if (!format.trim()) return null;
    let pattern = "";
    const fields: Field[] = [];
    let i = 0;
    outer: while (i < format.length) {
        if (format[i] === "[") {
            const end = format.indexOf("]", i);
            if (end !== -1) {
                pattern += escapeRe(format.slice(i + 1, end));
                i = end + 1;
                continue;
            }
        }
        for (const [tok, re, field] of TOKENS) {
            if (format.startsWith(tok, i)) {
                pattern += re;
                fields.push(field);
                i += tok.length;
                continue outer;
            }
        }
        pattern += escapeRe(format[i]);
        i++;
    }
    if (!fields.includes("year") && !fields.includes("year2")) return null;
    if (!fields.includes("month") && !fields.includes("monthName")) return null;
    if (!fields.includes("day")) return null;

    const re = new RegExp(`^${pattern}$`, "i");
    return (name: string) => {
        const m = re.exec(name.trim());
        if (!m) return null;
        let y = 0;
        let mo = 0;
        let d = 0;
        fields.forEach((field, idx) => {
            const v = m[idx + 1];
            if (field === "year") y = Number(v);
            else if (field === "year2") y = 2000 + Number(v);
            else if (field === "month") mo = Number(v);
            else if (field === "monthName")
                mo = MONTHS.findIndex((n) => n.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))) + 1;
            else if (field === "day") d = Number(v);
        });
        const date = new Date(Date.UTC(y, mo - 1, d));
        if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
            return null; // e.g. Feb 30
        }
        return date.toISOString().slice(0, 10);
    };
}

// Builds the path -> date lookup for daily notes: a note counts when it's
// inside `folder` (any depth; "" means the whole vault) and its name — or,
// for formats containing "/", its path below the folder — fits `format`.
export function journalDater(folder: string, format: string): (path: string) => string | null {
    const parse = compileDateFormat(format);
    if (!parse) return () => null;
    const prefix = folder.replace(/^\/+|\/+$/g, "");
    const byPath = format.includes("/");
    return (path: string) => {
        if (!/\.md$/i.test(path)) return null;
        if (prefix && !path.startsWith(`${prefix}/`)) return null;
        const rel = (prefix ? path.slice(prefix.length + 1) : path).replace(/\.md$/i, "");
        return parse(byPath ? rel : rel.slice(rel.lastIndexOf("/") + 1));
    };
}

// ---------------------------------------------------------------------------
// Finding entries in notes
// ---------------------------------------------------------------------------

// The form a symbol is compared in: NFC, without the emoji variation
// selector (U+FE0F), so "⭐" and "⭐️" are the same symbol.
export function symbolKey(s: string): string {
    return s.normalize("NFC").replace(/️/g, "").trim();
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const EMOJI_RUN =
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)*/gu;
const WORDISH = /^[\p{L}\p{N}_-]+$/u;
const MARKUP_EDGES = /^[*_~=`"'([{<>]+|[*_~=`"')\]}>]+$/g;
const MAX_ENTRY_TEXT = 200;

export interface TokenHit {
    token: string; // symbolKey() of what was logged, e.g. "🧭"
    raw?: string; // as written, when that differs from token (e.g. "🌧️" vs "🌧")
    line: number; // 0-based
    text: string; // what follows it on the line, e.g. "tired but okay"
}

// Finds every logged symbol in a note. With a suffix like "::", an entry is
// "<symbol><suffix>": the symbol is the whole run of non-space characters
// right before the suffix (so "🧠📺::" is 🧠📺, never 📺 or 🧠), which also
// works for non-emoji symbols. Plain word fields such as Dataview's
// "mood:: good" are skipped. With no suffix, every run of emoji counts.
export function extractTokens(content: string, suffix: string): TokenHit[] {
    const hits: TokenHit[] = [];
    const sfx = suffix.trim();
    const lines = content.split(/\r?\n/);
    lines.forEach((line, lineNo) => {
        const found: { token: string; raw: string; start: number; end: number }[] = [];
        if (sfx) {
            let from = 0;
            for (;;) {
                const at = line.indexOf(sfx, from);
                if (at === -1) break;
                from = at + sfx.length;
                let start = at;
                while (start > 0 && !/\s/.test(line[start - 1])) start--;
                const raw = line.slice(start, at).replace(MARKUP_EDGES, "").trim();
                const token = symbolKey(raw);
                if (!token || WORDISH.test(token)) continue;
                found.push({ token, raw, start, end: at + sfx.length });
            }
        } else {
            EMOJI_RUN.lastIndex = 0;
            for (let m = EMOJI_RUN.exec(line); m; m = EMOJI_RUN.exec(line)) {
                const token = symbolKey(m[0]);
                if (token) found.push({ token, raw: m[0], start: m.index, end: m.index + m[0].length });
            }
        }
        found.forEach((f, idx) => {
            const stop = idx + 1 < found.length ? found[idx + 1].start : line.length;
            const text = line.slice(f.end, stop).trim().slice(0, MAX_ENTRY_TEXT);
            const hit: TokenHit = { token: f.token, line: lineNo, text };
            if (f.raw !== f.token) hit.raw = f.raw;
            hits.push(hit);
        });
    });
    return hits;
}

export function isPictographic(token: string): boolean {
    return PICTOGRAPHIC.test(token);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface IndexedNote {
    path: string;
    hits: TokenHit[];
}

export interface Entry {
    date: string;
    path: string;
    line: number;
    text: string;
}

export interface SymbolStats {
    total: number; // every occurrence in the vault (journal or not)
    notes: number; // notes containing it
    days: Map<string, number>; // journal date -> occurrences that day
    lastDate: string | null;
    recent: Entry[]; // newest first, journal notes only
}

export interface Streaks {
    current: number; // consecutive days up to today (or yesterday, if today isn't logged yet)
    longest: number;
}

export interface WeekdayLean {
    weekday: number; // 0 = Monday
    share: number; // 0..1 of logged days that fall on it
}

export interface CoOccurrence {
    a: string; // symbol keys
    b: string;
    days: number;
}

export interface Untracked {
    token: string;
    display: string; // as first written in a note, variation selector intact
    total: number;
    notes: number;
    lastPath: string;
    lastDate: string | null;
}

export interface JournalStats {
    bySymbol: Map<string, SymbolStats>; // keyed by symbolKey(entry.emoji)
    journalDates: Set<string>; // every daily note's date, symbols or not
    dayTotals: Map<string, number>; // journal date -> all symbol occurrences
    daySymbols: Map<string, Set<string>>; // journal date -> symbol keys logged
    untracked: Untracked[];
    indexedNotes: number;
}

const RECENT_LIMIT = 10;

// Rolls an index of notes up into per-symbol and whole-journal numbers.
// Only symbols in the atlas are counted as symbols; any other pictographic
// token becomes an "untracked" upkeep item.
export function aggregate(
    notes: IndexedNote[],
    symbols: SymbolEntry[],
    dateOf: (path: string) => string | null
): JournalStats {
    const known = new Set(symbols.map((s) => symbolKey(s.emoji)));
    const bySymbol = new Map<string, SymbolStats>();
    for (const key of known) {
        bySymbol.set(key, { total: 0, notes: 0, days: new Map(), lastDate: null, recent: [] });
    }
    const journalDates = new Set<string>();
    const dayTotals = new Map<string, number>();
    const daySymbols = new Map<string, Set<string>>();
    const untracked = new Map<string, Untracked>();
    const allRecent = new Map<string, Entry[]>();

    for (const note of notes) {
        const date = dateOf(note.path);
        if (date) journalDates.add(date);
        const seenInNote = new Set<string>();
        for (const hit of note.hits) {
            const stats = bySymbol.get(hit.token);
            if (stats) {
                stats.total++;
                if (!seenInNote.has(hit.token)) stats.notes++;
                if (date) {
                    stats.days.set(date, (stats.days.get(date) ?? 0) + 1);
                    if (!stats.lastDate || date > stats.lastDate) stats.lastDate = date;
                    dayTotals.set(date, (dayTotals.get(date) ?? 0) + 1);
                    if (!daySymbols.has(date)) daySymbols.set(date, new Set());
                    daySymbols.get(date)!.add(hit.token);
                    if (!allRecent.has(hit.token)) allRecent.set(hit.token, []);
                    allRecent.get(hit.token)!.push({ date, path: note.path, line: hit.line, text: hit.text });
                }
            } else if (isPictographic(hit.token)) {
                let u = untracked.get(hit.token);
                if (!u) {
                    u = {
                        token: hit.token,
                        display: hit.raw ?? hit.token,
                        total: 0,
                        notes: 0,
                        lastPath: note.path,
                        lastDate: date,
                    };
                    untracked.set(hit.token, u);
                }
                u.total++;
                if (!seenInNote.has(hit.token)) u.notes++;
                if (date && (!u.lastDate || date > u.lastDate)) {
                    u.lastDate = date;
                    u.lastPath = note.path;
                }
            }
            seenInNote.add(hit.token);
        }
    }

    for (const [key, entries] of allRecent) {
        entries.sort((a, b) => (a.date === b.date ? a.line - b.line : a.date < b.date ? 1 : -1));
        bySymbol.get(key)!.recent = entries.slice(0, RECENT_LIMIT);
    }

    return {
        bySymbol,
        journalDates,
        dayTotals,
        daySymbols,
        untracked: [...untracked.values()].sort((a, b) => b.total - a.total || a.token.localeCompare(b.token)),
        indexedNotes: notes.length,
    };
}

// Days (distinct) a symbol was logged within the `span` days ending today.
export function daysLoggedWithin(days: Map<string, number>, today: string, span: number): number {
    const end = dayNumber(today);
    let n = 0;
    for (const d of days.keys()) {
        const k = dayNumber(d);
        if (k <= end && k > end - span) n++;
    }
    return n;
}

// Days logged in each of the last `weeks` 7-day windows ending today,
// oldest first.
export function weeklyDays(days: Map<string, number>, today: string, weeks: number): number[] {
    const end = dayNumber(today);
    const out = new Array<number>(weeks).fill(0);
    for (const d of days.keys()) {
        const ago = end - dayNumber(d);
        if (ago < 0) continue;
        const w = Math.floor(ago / 7);
        if (w < weeks) out[weeks - 1 - w]++;
    }
    return out;
}

export function streaks(days: Map<string, number>, today: string): Streaks {
    const nums = [...days.keys()].map(dayNumber).sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    for (let i = 0; i < nums.length; i++) {
        run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    const set = new Set(nums);
    const t = dayNumber(today);
    let cursor = set.has(t) ? t : t - 1; // today not logged yet doesn't break a streak
    let current = 0;
    while (set.has(cursor)) {
        current++;
        cursor--;
    }
    return { current, longest };
}

// The weekday a symbol clearly leans towards, if any: needs at least 5
// logged days and one weekday holding 30%+ of them.
export function weekdayLean(days: Map<string, number>): WeekdayLean | null {
    if (days.size < 5) return null;
    const counts = new Array<number>(7).fill(0);
    for (const d of days.keys()) counts[weekdayIndex(d)]++;
    const max = Math.max(...counts);
    const share = max / days.size;
    if (share < 0.3) return null;
    return { weekday: counts.indexOf(max), share };
}

export interface Change {
    key: string;
    before: number; // occurrences in the previous window
    after: number; // occurrences in the latest window
}

// Compares each symbol's occurrences in the last `span` days against the
// `span` days before that; biggest movers first.
export function compareWindows(stats: JournalStats, today: string, span = 30, limit = 5): Change[] {
    const end = dayNumber(today);
    const changes: Change[] = [];
    for (const [key, s] of stats.bySymbol) {
        let before = 0;
        let after = 0;
        for (const [d, n] of s.days) {
            const ago = end - dayNumber(d);
            if (ago < 0) continue;
            if (ago < span) after += n;
            else if (ago < span * 2) before += n;
        }
        if (before !== after) changes.push({ key, before, after });
    }
    return changes
        .sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || x.key.localeCompare(y.key))
        .slice(0, limit);
}

export interface Coverage {
    journalDays: number; // daily notes in the window
    daysWithSymbols: number;
    perDay: number; // average symbol occurrences per daily note
}

// How consistently daily notes carry symbols, over the `span` days ending
// today (or all time when span is omitted).
export function coverage(stats: JournalStats, today: string, span?: number): Coverage {
    const end = dayNumber(today);
    const inWindow = (d: string) => {
        const ago = end - dayNumber(d);
        return ago >= 0 && (span === undefined || ago < span);
    };
    let journalDays = 0;
    let daysWithSymbols = 0;
    let total = 0;
    for (const d of stats.journalDates) {
        if (!inWindow(d)) continue;
        journalDays++;
        const n = stats.dayTotals.get(d) ?? 0;
        if (n > 0) daysWithSymbols++;
        total += n;
    }
    return { journalDays, daysWithSymbols, perDay: journalDays ? total / journalDays : 0 };
}

// Pairs of symbols most often logged on the same day (2+ days together).
export function coOccurrences(stats: JournalStats, limit = 5): CoOccurrence[] {
    const pairs = new Map<string, CoOccurrence>();
    for (const keys of stats.daySymbols.values()) {
        const list = [...keys].sort();
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const id = `${list[i]}\u0000${list[j]}`;
                const p = pairs.get(id) ?? { a: list[i], b: list[j], days: 0 };
                p.days++;
                pairs.set(id, p);
            }
        }
    }
    return [...pairs.values()]
        .filter((p) => p.days >= 2)
        .sort((x, y) => y.days - x.days || x.a.localeCompare(y.a))
        .slice(0, limit);
}

// Atlas symbols not seen in the journal for `days` days (or never).
export function dormantSymbols(
    stats: JournalStats,
    symbols: SymbolEntry[],
    today: string,
    days: number
): { symbol: SymbolEntry; lastDate: string | null }[] {
    const cutoff = dayNumber(today) - days;
    return symbols
        .map((symbol) => ({ symbol, lastDate: stats.bySymbol.get(symbolKey(symbol.emoji))?.lastDate ?? null }))
        .filter(({ lastDate }) => !lastDate || dayNumber(lastDate) <= cutoff)
        .sort((a, b) => (a.lastDate ?? "").localeCompare(b.lastDate ?? "") || a.symbol.name.localeCompare(b.symbol.name));
}

// Daily counts for a heatmap: `weeks` full Monday-start weeks ending with
// the current week, oldest first, 7 days per week (future days are null).
export function heatmapWeeks(
    dayCounts: Map<string, number>,
    today: string,
    weeks: number
): ({ date: string; count: number } | null)[][] {
    const t = dayNumber(today);
    const thisMonday = t - weekdayIndex(today);
    const start = thisMonday - (weeks - 1) * 7;
    const out: ({ date: string; count: number } | null)[][] = [];
    for (let w = 0; w < weeks; w++) {
        const col: ({ date: string; count: number } | null)[] = [];
        for (let d = 0; d < 7; d++) {
            const n = start + w * 7 + d;
            if (n > t) {
                col.push(null);
                continue;
            }
            const date = dateFromDayNumber(n);
            col.push({ date, count: dayCounts.get(date) ?? 0 });
        }
        out.push(col);
    }
    return out;
}
