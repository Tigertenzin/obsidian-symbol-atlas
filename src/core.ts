// Pure helpers with no runtime dependency on the Obsidian API, kept apart
// from main.ts so they can be unit-tested directly under Node.
import type { HeadingCache } from "obsidian";
import { emojiToName } from "gemoji";

export interface SymbolEntry {
    id: string;
    emoji: string;
    name: string;
    subtitle?: string; // optional extra context, shown under the name in the picker
    lastUsed?: number; // epoch ms, undefined if never used
    useCount?: number; // times inserted via the picker/sidebar, undefined if never used
}

export const DEFAULT_SYMBOLS: SymbolEntry[] = [
    { id: "default-done", emoji: "✅", name: "done / completed" },
    { id: "default-wip", emoji: "🚧", name: "in progress / work in progress" },
    { id: "default-warning", emoji: "❗", name: "important / warning" },
    { id: "default-idea", emoji: "💡", name: "idea" },
    { id: "default-link", emoji: "🔗", name: "link / reference" },
    { id: "default-pinned", emoji: "📌", name: "pinned / priority" },
    { id: "default-bug", emoji: "🐛", name: "bug" },
    { id: "default-urgent", emoji: "🔥", name: "urgent / hot" },
    { id: "default-reading", emoji: "📚", name: "reading / book" },
    { id: "default-game", emoji: "🎮", name: "game / gaming" },
];

// Splits a string into individual emoji "graphemes" (handles multi-emoji
// combos like "🧠📺" by breaking them into "🧠" and "📺" separately) and
// looks up each one's official Unicode name via the gemoji dataset.
export function getEmojiNames(emojiStr: string): string {
    let graphemes: string[];
    // @ts-ignore - Intl.Segmenter is available in modern Electron/Chromium
    if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
        // @ts-ignore
        const segmenter = new (Intl as any).Segmenter("en", {
            granularity: "grapheme",
        });
        graphemes = Array.from(segmenter.segment(emojiStr), (s: any) => s.segment);
    } else {
        graphemes = Array.from(emojiStr);
    }

    const names: string[] = [];
    for (const g of graphemes) {
        const name = (emojiToName as Record<string, string>)[g];
        if (name && !names.includes(name)) {
            names.push(name);
        }
    }
    return names.join(" ");
}

export function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `sym-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Builds one validated SymbolEntry from an arbitrary parsed JSON value.
// Throws a descriptive Error on the first problem found so import can fail
// fast with an actionable message instead of silently admitting bad data.
function toImportedSymbol(
    raw: unknown,
    index: number,
    seenIds: Set<string>
): SymbolEntry {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`Entry ${index + 1} is not a valid object.`);
    }
    const obj = raw as Record<string, unknown>;

    const emoji = typeof obj.emoji === "string" ? obj.emoji.trim() : "";
    if (!emoji) {
        throw new Error(`Entry ${index + 1} is missing a valid "emoji".`);
    }
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) {
        throw new Error(`Entry ${index + 1} is missing a valid "name".`);
    }

    // Preserve an imported id for clean export/import round-trips, as long
    // as it's not already claimed by an earlier entry in this same batch.
    // Old (pre-1.2) exports have no id at all, so falling back to a fresh
    // one here is also what makes those imports still work.
    const candidateId = typeof obj.id === "string" ? obj.id.trim() : "";
    const id = candidateId && !seenIds.has(candidateId) ? candidateId : generateId();
    seenIds.add(id);

    const entry: SymbolEntry = { id, emoji, name };
    if (typeof obj.subtitle === "string" && obj.subtitle.trim()) {
        entry.subtitle = obj.subtitle.trim();
    }
    if (typeof obj.lastUsed === "number" && Number.isFinite(obj.lastUsed)) {
        entry.lastUsed = obj.lastUsed;
    }
    if (
        typeof obj.useCount === "number" &&
        Number.isInteger(obj.useCount) &&
        obj.useCount > 0
    ) {
        entry.useCount = obj.useCount;
    }
    return entry;
}

// Parses and validates a full import payload. Rejects the whole batch (no
// partial/silent-skip) if anything is malformed, since a bad paste almost
// always means the whole paste is wrong, not just one entry.
export function parseImportedSymbols(text: string): SymbolEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON. Import failed.");
    }
    if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array of symbols.");
    }
    const seenIds = new Set<string>();
    return parsed.map((raw, index) => toImportedSymbol(raw, index, seenIds));
}

export interface ParsedSymbol {
    emoji: string;
    name: string;
    subtitle?: string;
}

// Canonical form for comparing user-visible text that may have been typed
// or stored on different devices. iOS/macOS file systems and keyboards can
// produce decomposed (NFD) Unicode while other platforms produce composed
// (NFC), so "é" or many emoji-adjacent characters can differ byte-for-byte
// while looking identical.
export function canonicalText(s: string): string {
    return s.normalize("NFC").trim();
}

export function headingMatches(heading: string, wanted: string): boolean {
    return canonicalText(heading) === canonicalText(wanted);
}

// Finds the H2 heading matching headingText and returns the raw lines
// strictly between it and the next heading of level <= 2 (or EOF). Always
// slices the raw, unmodified file content (frontmatter included) — Heading
// positions are 0-based line indexes into that exact string, so stripping
// anything beforehand would throw off every line number.
export function extractSection(
    content: string,
    headings: HeadingCache[],
    headingText: string
): string[] | null {
    const target = headings.find(
        (h) => h.level === 2 && headingMatches(h.heading, headingText)
    );
    if (!target) return null;

    const idx = headings.indexOf(target);
    let boundaryLine: number | null = null;
    for (let i = idx + 1; i < headings.length; i++) {
        if (headings[i].level <= 2) {
            boundaryLine = headings[i].position.start.line;
            break;
        }
    }

    const lines = content.split(/\r?\n/);
    const startLine = target.position.start.line + 1;
    const endLine = boundaryLine === null ? lines.length : boundaryLine;
    return lines.slice(startLine, endLine);
}

interface ListStackFrame {
    indent: number;
    symbol: ParsedSymbol | null; // set only when this line is itself a "::" symbol
}

// Width of a list item's leading whitespace, with tabs expanded to the next
// multiple of 4 so a tab-indented child still nests under a space-indented
// parent (Obsidian on iPad and desktop default to different indent styles).
function indentWidth(ws: string): number {
    let width = 0;
    for (const ch of ws) {
        width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
    }
    return width;
}

// Matches list-item lines at any nesting depth and splits each "::" line
// into {emoji, name}. A line WITHOUT "::" becomes a subtitle fragment on
// its direct parent bullet, but only if that parent is itself a "::" line
// (multiple such children join with a space, in document order) — it does
// NOT bubble further up, and a "::" line nested under a non-"::" line is
// still its own independent symbol either way. Indentation is tracked via
// a small stack so this works regardless of nesting depth or how deeply a
// "::" line's own children are indented. Ordered ("1.") and task ("- [ ]")
// list markers are accepted too.
export function parseSymbolsFromLines(lines: string[]): ParsedSymbol[] {
    const out: ParsedSymbol[] = [];
    const listItemRe = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*)$/;
    const stack: ListStackFrame[] = [];

    for (const line of lines) {
        const match = listItemRe.exec(line);
        if (!match) continue;
        const indent = indentWidth(match[1]);
        const text = match[2];

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        const parent = stack.length > 0 ? stack[stack.length - 1] : null;

        const sep = text.indexOf("::");
        if (sep !== -1) {
            const emoji = text.slice(0, sep).trim();
            const name = text.slice(sep + 2).trim();
            if (emoji && name) {
                const symbol: ParsedSymbol = { emoji, name };
                out.push(symbol);
                stack.push({ indent, symbol });
                continue;
            }
            // Malformed "::" line (empty emoji or name) — drop it, but
            // still track it so its own children don't misattach to a
            // grandparent's subtitle.
            stack.push({ indent, symbol: null });
            continue;
        }

        if (parent?.symbol) {
            const trimmed = text.trim();
            if (trimmed) {
                parent.symbol.subtitle = parent.symbol.subtitle
                    ? `${parent.symbol.subtitle} ${trimmed}`
                    : trimmed;
            }
        }
        stack.push({ indent, symbol: null });
    }
    return out;
}

// Reconciles a freshly-parsed symbol list against the previous one so a
// re-sync never resets usage history: entries are matched to existing ones
// by emoji (a FIFO queue per emoji handles duplicates without special
// casing), preserving id/lastUsed/useCount on a match. Existing entries
// whose emoji no longer appears are dropped — the note is the source of
// truth once in note mode, so a removed line should disappear from the
// picker too.
export function mergeParsedSymbols(
    parsed: ParsedSymbol[],
    existing: SymbolEntry[]
): SymbolEntry[] {
    const pool = new Map<string, SymbolEntry[]>();
    for (const e of existing) {
        const key = e.emoji.normalize("NFC");
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key)!.push(e);
    }
    return parsed.map(({ emoji, name, subtitle }) => {
        const match = pool.get(emoji.normalize("NFC"))?.shift();
        const entry: SymbolEntry = { id: match?.id ?? generateId(), emoji, name };
        if (subtitle) entry.subtitle = subtitle;
        if (match?.lastUsed !== undefined) entry.lastUsed = match.lastUsed;
        if (match?.useCount !== undefined) entry.useCount = match.useCount;
        return entry;
    });
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

// Whether two vault paths name the same note, ignoring Unicode
// normalization and letter case (see resolveNotePath).
export function samePath(a: string, b: string): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

// Resolves a stored note path against the vault's actual file paths,
// tolerating the ways a path saved on one device can fail to match
// byte-for-byte on another (or after a sync): Unicode normalization
// (NFC vs NFD), letter case (iOS/macOS file systems are case-insensitive),
// stray leading/trailing slashes, a missing ".md", and finally a note that
// was moved to another folder while this device wasn't watching (matched
// by file name, only when exactly one note has that name). Returns the
// real path, or null when there's no confident match.
export function resolveNotePath(stored: string, candidates: string[]): string | null {
    const cleaned = stored.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return null;
    const wanted = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;

    if (candidates.includes(wanted)) return wanted;

    const nfc = wanted.normalize("NFC");
    const byNfc = candidates.filter((p) => p.normalize("NFC") === nfc);
    if (byNfc.length === 1) return byNfc[0];

    const folded = nfc.toLowerCase();
    const byCase = candidates.filter((p) => p.normalize("NFC").toLowerCase() === folded);
    if (byCase.length === 1) return byCase[0];

    const name = basename(folded);
    const byName = candidates.filter(
        (p) => basename(p.normalize("NFC").toLowerCase()) === name
    );
    if (byName.length === 1) return byName[0];

    return null;
}

// Short human description of how long ago a timestamp was, e.g. "3d ago".
export function formatRelative(ts: number, now = Date.now()): string {
    const sec = Math.max(0, Math.round((now - ts) / 1000));
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mon = Math.round(day / 30);
    if (mon < 12) return `${mon}mo ago`;
    return `${Math.round(day / 365)}y ago`;
}
