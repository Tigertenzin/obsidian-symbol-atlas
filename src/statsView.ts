import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SymbolAtlasPlugin from "../main";
import { SymbolEntry, formatRelative, getEmojiNames } from "./core";
import {
    Entry,
    JournalStats,
    SymbolStats,
    WEEKDAYS,
    coOccurrences,
    compareWindows,
    coverage,
    dayNumber,
    daysLoggedWithin,
    dormantSymbols,
    formatShortDate,
    heatmapWeeks,
    localToday,
    streaks,
    symbolKey,
    weekdayLean,
    weeklyDays,
} from "./stats";
import { chip, daysAgo, openNote, settingsLink, symbolForKey } from "./viewUtils";

export const VIEW_TYPE_SYMBOL_STATS = "symbol-atlas-stats";

type CardSort = "logged" | "vault" | "alpha" | "inserted";

const FREQUENCY_WEEKS = 8;
const UPKEEP_LIMIT = 12;

// Full-width stats page, opened as a tab in the main area: everything that
// would be too cramped for the sidebar.
export class SymbolAtlasStatsView extends ItemView {
    plugin: SymbolAtlasPlugin;
    private heatmapSymbol = ""; // symbolKey, or "" for all symbols
    private query = "";
    private sort: CardSort = "logged";
    private topEl: HTMLElement;
    private cardsEl: HTMLElement;
    private lastWide: boolean | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SymbolAtlasPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_SYMBOL_STATS;
    }

    getDisplayText(): string {
        return "Symbol Atlas stats";
    }

    getIcon(): string {
        return "bar-chart-3";
    }

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass("symbol-atlas-stats-page");
        this.topEl = root.createDiv({ cls: "symbol-atlas-page-top" });

        const symbolsHead = root.createDiv({ cls: "symbol-atlas-page-heading" });
        symbolsHead.createEl("h3", { text: "Symbols" });
        const controls = symbolsHead.createDiv({ cls: "symbol-atlas-controls" });
        const search = controls.createEl("input", {
            type: "search",
            cls: "symbol-atlas-search",
            attr: { placeholder: "Filter symbols…", "aria-label": "Filter symbols" },
        });
        search.addEventListener("input", () => {
            this.query = search.value;
            this.renderCards();
        });
        const sortSelect = controls.createEl("select", {
            cls: "dropdown",
            attr: { "aria-label": "Sort symbols" },
        });
        const options: [CardSort, string][] = [
            ["logged", "Recently logged"],
            ["vault", "Most logged"],
            ["inserted", "Most inserted"],
            ["alpha", "A–Z"],
        ];
        for (const [value, label] of options) sortSelect.createEl("option", { value, text: label });
        sortSelect.value = this.sort;
        sortSelect.addEventListener("change", () => {
            this.sort = sortSelect.value as CardSort;
            this.renderCards();
        });

        this.cardsEl = root.createDiv({ cls: "symbol-atlas-cards" });
        this.refresh();
    }

    async onClose() {
        this.contentEl.empty();
    }

    // The heatmap's length depends on the page width.
    onResize() {
        const wide = this.isWide();
        if (wide !== this.lastWide) this.renderTop();
    }

    private isWide(): boolean {
        return this.contentEl.clientWidth >= 620;
    }

    refresh() {
        if (!this.topEl || !this.cardsEl) return;
        this.renderTop();
        this.renderCards();
    }

    // ---------------------------------------------------------------------
    // Overview, journal and upkeep panels
    // ---------------------------------------------------------------------

    private renderTop() {
        const el = this.topEl;
        el.empty();
        this.lastWide = this.isWide();
        const { settings, index } = this.plugin;
        const stats = this.plugin.getStats();
        const today = localToday();
        const js = settings.journalStats;

        const header = el.createDiv({ cls: "symbol-atlas-page-header" });
        header.createEl("h2", { text: "Symbol Atlas stats" });
        const status = header.createDiv({ cls: "symbol-atlas-status symbol-atlas-meta" });
        status.createSpan({
            text: index.building
                ? `Indexing notes… ${index.progress.done}/${index.progress.total}`
                : index.ready
                ? `${index.noteCount.toLocaleString()} notes indexed`
                : "Loading index…",
        });
        const rebuild = status.createDiv({
            cls: "clickable-icon",
            attr: { "aria-label": "Rebuild the index from scratch" },
        });
        setIcon(rebuild, "refresh-cw");
        rebuild.addEventListener("click", () => this.plugin.rebuildIndex());
        const gear = status.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Stats settings" } });
        setIcon(gear, "settings");
        gear.addEventListener("click", () => this.plugin.openSettings());

        if (js.overview) this.renderOverview(el, stats);
        if (js.top) this.renderTopChips(el, stats);

        const panels = el.createDiv({ cls: "symbol-atlas-panels" });
        const panel = (title: string, wide = false) => {
            const p = panels.createDiv({ cls: "symbol-atlas-panel" });
            if (wide) p.addClass("is-wide");
            p.createDiv({ cls: "symbol-atlas-block-title", text: title });
            return p;
        };

        const anyJournal = js.heatmap || js.trend || js.coverage || js.together;
        if (anyJournal && stats.journalDates.size === 0) {
            const p = panel("Journal", true);
            const hint = p.createDiv({ cls: "symbol-atlas-meta" });
            if (index.ready) {
                const where = settings.journalFolder ? `in "${settings.journalFolder}"` : "in your vault";
                hint.appendText(
                    `No daily notes ${where} match the filename format "${settings.journalDateFormat}". `
                );
                settingsLink(this.plugin, hint, "Set the journal folder and format in settings.");
            } else {
                hint.setText("Indexing notes…");
            }
        } else {
            if (js.heatmap) this.renderHeatmap(panel("Activity", true), stats, today);
            if (js.trend) this.renderTrend(panel("Last 30 days vs the 30 before"), stats, today);
            if (js.coverage) this.renderCoverage(panel("Coverage"), stats, today);
            if (js.together) this.renderTogether(panel("Often logged together"), stats);
        }
        if (settings.upkeep.untracked) this.renderUntracked(panel("Untracked symbols"), stats, today);
        if (settings.upkeep.dormant) {
            this.renderDormant(panel(`Not logged in ${settings.dormantDays}+ days`), stats, today);
        }
    }

    private renderOverview(el: HTMLElement, stats: JournalStats) {
        const { symbols } = this.plugin.settings;
        let entries = 0;
        for (const s of stats.bySymbol.values()) entries += s.total;
        const insertions = symbols.reduce((sum, s) => sum + (s.useCount ?? 0), 0);
        const tiles = el.createDiv({ cls: "symbol-atlas-tiles" });
        const tile = (value: number, label: string, tip: string) => {
            const t = tiles.createDiv({ cls: "symbol-atlas-tile", attr: { "aria-label": tip } });
            t.createDiv({ cls: "symbol-atlas-tile-value", text: value.toLocaleString() });
            t.createDiv({ cls: "symbol-atlas-tile-label", text: label });
        };
        tile(symbols.length, "symbols", "Symbols in your atlas");
        tile(entries, "entries", "Times atlas symbols appear in your notes");
        tile(stats.journalDates.size, "journal days", "Daily notes found");
        tile(insertions, "insertions", "Symbols inserted with the picker or sidebar");
    }

    private renderTopChips(el: HTMLElement, stats: JournalStats) {
        const { symbols } = this.plugin.settings;
        const logged = symbols
            .map((s) => ({ s, n: stats.bySymbol.get(symbolKey(s.emoji))?.total ?? 0 }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n)
            .slice(0, 8);
        if (logged.length > 0) {
            const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
            row.createSpan({ cls: "symbol-atlas-chip-label", text: "Most logged" });
            for (const { s, n } of logged) chip(row, s, String(n));
        }
        const inserted = symbols
            .filter((s) => (s.useCount ?? 0) > 0)
            .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
            .slice(0, 8);
        if (inserted.length > 0) {
            const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
            row.createSpan({ cls: "symbol-atlas-chip-label", text: "Most inserted" });
            for (const s of inserted) chip(row, s, `${s.useCount}×`);
        }
    }

    private renderHeatmap(p: HTMLElement, stats: JournalStats, today: string) {
        const head = p.createDiv({ cls: "symbol-atlas-block-head" });
        const weeksCount = this.isWide() ? 52 : 26;
        head.createSpan({ cls: "symbol-atlas-meta", text: `Entries per day, last ${weeksCount} weeks` });
        const select = head.createEl("select", {
            cls: "dropdown symbol-atlas-heatmap-select",
            attr: { "aria-label": "Symbol shown in the activity heatmap" },
        });
        select.createEl("option", { value: "", text: "All symbols" });
        for (const s of this.plugin.settings.symbols) {
            select.createEl("option", { value: symbolKey(s.emoji), text: `${s.emoji} ${s.name}` });
        }
        select.value = this.heatmapSymbol;
        if (select.value !== this.heatmapSymbol) this.heatmapSymbol = ""; // symbol was removed
        select.addEventListener("change", () => {
            this.heatmapSymbol = select.value;
            this.renderTop();
        });

        const counts = this.heatmapSymbol
            ? stats.bySymbol.get(this.heatmapSymbol)?.days ?? new Map<string, number>()
            : stats.dayTotals;
        const weeks = heatmapWeeks(counts, today, weeksCount);
        let max = 0;
        for (const col of weeks) for (const c of col) if (c) max = Math.max(max, c.count);

        const grid = p.createDiv({
            cls: "symbol-atlas-heatmap",
            attr: { role: "img", "aria-label": `Entries per day over the last ${weeksCount} weeks` },
        });
        for (const col of weeks) {
            for (const cell of col) {
                const c = grid.createDiv({ cls: "symbol-atlas-heat-cell" });
                if (!cell) {
                    c.addClass("is-future");
                    continue;
                }
                const level = cell.count === 0 ? 0 : Math.max(1, Math.ceil((cell.count / max) * 4));
                c.dataset.level = String(level);
                const noNote = stats.journalDates.has(cell.date) ? "" : " (no daily note)";
                c.setAttribute(
                    "aria-label",
                    `${formatShortDate(cell.date, today)}: ${cell.count} ${cell.count === 1 ? "entry" : "entries"}${noNote}`
                );
            }
        }
        const legend = p.createDiv({ cls: "symbol-atlas-heat-legend symbol-atlas-meta" });
        legend.createSpan({ text: `${formatShortDate(weeks[0][0]!.date, today)} – today` });
        const scale = legend.createSpan({ cls: "symbol-atlas-heat-scale" });
        scale.createSpan({ text: "Less" });
        for (let l = 0; l <= 4; l++) {
            scale.createDiv({ cls: "symbol-atlas-heat-cell", attr: { "data-level": String(l) } });
        }
        scale.createSpan({ text: "More" });
    }

    private statRow(p: HTMLElement, emoji: string, name: string, value: string, tip?: string) {
        const row = p.createDiv({ cls: "symbol-atlas-stat-row" });
        row.createSpan({ cls: "symbol-atlas-stat-emoji", text: emoji });
        row.createSpan({ cls: "symbol-atlas-stat-name", text: name });
        row.createSpan({ cls: "symbol-atlas-stat-value", text: value, attr: tip ? { "aria-label": tip } : {} });
        return row;
    }

    private renderTrend(p: HTMLElement, stats: JournalStats, today: string) {
        const changes = compareWindows(stats, today, 30, 8);
        if (changes.length === 0) {
            p.createDiv({ cls: "symbol-atlas-meta", text: "No change." });
            return;
        }
        for (const ch of changes) {
            const s = symbolForKey(this.plugin, ch.key);
            this.statRow(
                p,
                s?.emoji ?? ch.key,
                s?.name ?? "",
                `${ch.before} → ${ch.after} ${ch.after > ch.before ? "↑" : "↓"}`,
                `${ch.before} entries in the 30 days before, ${ch.after} in the last 30`
            );
        }
    }

    private renderCoverage(p: HTMLElement, stats: JournalStats, today: string) {
        const line = (label: string, span?: number) => {
            const c = coverage(stats, today, span);
            if (c.journalDays === 0) return;
            const pct = Math.round((c.daysWithSymbols / c.journalDays) * 100);
            const perDay = c.perDay.toFixed(1);
            this.statRow(
                p,
                "",
                label,
                `${c.daysWithSymbols}/${c.journalDays} days (${pct}%) · ${perDay}/day`,
                `${c.daysWithSymbols} of ${c.journalDays} daily notes have symbols; ${perDay} entries per daily note on average`
            );
        };
        line("Last 7 days", 7);
        line("Last 30 days", 30);
        line("Last 365 days", 365);
        line("All time");
    }

    private renderTogether(p: HTMLElement, stats: JournalStats) {
        const pairs = coOccurrences(stats, 8);
        if (pairs.length === 0) {
            p.createDiv({ cls: "symbol-atlas-meta", text: "Not enough overlap yet." });
            return;
        }
        for (const pair of pairs) {
            const a = symbolForKey(this.plugin, pair.a);
            const b = symbolForKey(this.plugin, pair.b);
            this.statRow(
                p,
                `${a?.emoji ?? pair.a} + ${b?.emoji ?? pair.b}`,
                `${a?.name ?? ""} + ${b?.name ?? ""}`,
                `${pair.days} days`
            );
        }
    }

    private renderUntracked(p: HTMLElement, stats: JournalStats, today: string) {
        const { settings } = this.plugin;
        if (!settings.symbolSuffix.trim()) {
            p.createDiv({
                cls: "symbol-atlas-meta",
                text: 'Set "Text to insert after each symbol" (e.g. "::") in settings to spot symbols used in notes but missing from your atlas.',
            });
            return;
        }
        if (stats.untracked.length === 0) {
            p.createDiv({ cls: "symbol-atlas-meta", text: "Every symbol in your notes is in the atlas." });
            return;
        }
        for (const u of stats.untracked.slice(0, UPKEEP_LIMIT)) {
            const row = p.createDiv({ cls: "symbol-atlas-stat-row" });
            row.createSpan({ cls: "symbol-atlas-stat-emoji", text: u.display });
            const where = row.createSpan({ cls: "symbol-atlas-stat-name symbol-atlas-meta" });
            where.appendText(`${u.total}× in ${u.notes} note${u.notes === 1 ? "" : "s"} · last `);
            const link = where.createEl("a", {
                text: u.lastDate ? formatShortDate(u.lastDate, today) : u.lastPath.replace(/\.md$/, ""),
                href: "#",
                attr: { "aria-label": `Open ${u.lastPath.replace(/\.md$/, "")}` },
            });
            link.addEventListener("click", (evt) => {
                evt.preventDefault();
                openNote(this.app, u.lastPath, undefined, "tab");
            });
            const add = row.createDiv({
                cls: "clickable-icon",
                attr: {
                    "aria-label": settings.symbolSource === "note" ? "Open the source note to add it" : "Add to atlas",
                },
            });
            setIcon(add, "plus");
            add.addEventListener("click", () => this.plugin.addSymbolFromToken(u.display));
        }
        if (stats.untracked.length > UPKEEP_LIMIT) {
            p.createDiv({ cls: "symbol-atlas-meta", text: `…and ${stats.untracked.length - UPKEEP_LIMIT} more` });
        }
    }

    private renderDormant(p: HTMLElement, stats: JournalStats, today: string) {
        const { settings } = this.plugin;
        if (stats.journalDates.size === 0) {
            const hint = p.createDiv({ cls: "symbol-atlas-meta" });
            settingsLink(this.plugin, hint, "Needs daily notes: set the journal folder and format in settings.");
            return;
        }
        const dormant = dormantSymbols(stats, settings.symbols, today, settings.dormantDays);
        if (dormant.length === 0) {
            p.createDiv({ cls: "symbol-atlas-meta", text: "Every symbol has been logged recently." });
        }
        for (const { symbol, lastDate } of dormant.slice(0, UPKEEP_LIMIT)) {
            this.statRow(p, symbol.emoji, symbol.name, lastDate ? formatShortDate(lastDate, today) : "never");
        }
        if (dormant.length > UPKEEP_LIMIT) {
            p.createDiv({ cls: "symbol-atlas-meta", text: `…and ${dormant.length - UPKEEP_LIMIT} more` });
        }
    }

    // ---------------------------------------------------------------------
    // Per-symbol cards
    // ---------------------------------------------------------------------

    private renderCards() {
        const el = this.cardsEl;
        el.empty();
        const stats = this.plugin.getStats();
        const today = localToday();
        const q = this.query.trim().toLowerCase();
        const st = (s: SymbolEntry) => stats.bySymbol.get(symbolKey(s.emoji));
        const byName = (a: SymbolEntry, b: SymbolEntry) => a.name.localeCompare(b.name);
        const keyed = (key: (s: SymbolEntry) => number) => (a: SymbolEntry, b: SymbolEntry) =>
            key(b) - key(a) || byName(a, b);
        const symbols = this.plugin.settings.symbols.filter((s) => {
            if (!q) return true;
            const hay = `${s.emoji} ${s.name} ${s.subtitle ?? ""} ${getEmojiNames(s.emoji)}`;
            return hay.toLowerCase().includes(q);
        });
        switch (this.sort) {
            case "alpha":
                symbols.sort(byName);
                break;
            case "vault":
                symbols.sort(keyed((s) => st(s)?.total ?? 0));
                break;
            case "inserted":
                symbols.sort(keyed((s) => s.useCount ?? 0));
                break;
            default:
                symbols.sort(keyed((s) => (st(s)?.lastDate ? dayNumber(st(s)!.lastDate!) : 0)));
        }
        if (symbols.length === 0) {
            el.createDiv({ cls: "symbol-atlas-empty", text: q ? "No symbols match." : "No symbols yet." });
            return;
        }
        for (const s of symbols) this.renderCard(el, s, st(s), stats, today);
    }

    private renderCard(el: HTMLElement, s: SymbolEntry, st: SymbolStats | undefined, stats: JournalStats, today: string) {
        const t = this.plugin.settings.symbolStats;
        const card = el.createDiv({ cls: "symbol-atlas-card" });
        const head = card.createDiv({ cls: "symbol-atlas-card-head" });
        head.createSpan({ cls: "symbol-atlas-emoji", text: s.emoji });
        const title = head.createDiv({ cls: "symbol-atlas-text" });
        title.createDiv({ cls: "symbol-atlas-name", text: s.name });
        if (s.subtitle) title.createDiv({ cls: "symbol-atlas-subtitle", text: s.subtitle });
        const show = head.createDiv({
            cls: "clickable-icon",
            attr: { "aria-label": "Show in the activity heatmap" },
        });
        setIcon(show, "calendar-days");
        show.addEventListener("click", () => {
            this.heatmapSymbol = symbolKey(s.emoji);
            this.renderTop();
            this.topEl.querySelector(".symbol-atlas-heatmap")?.scrollIntoView({ block: "center" });
        });

        const facts = card.createDiv({ cls: "symbol-atlas-facts" });
        const fact = (label: string, value: string) => {
            const f = facts.createDiv({ cls: "symbol-atlas-fact" });
            f.createDiv({ cls: "symbol-atlas-fact-value", text: value });
            f.createDiv({ cls: "symbol-atlas-fact-label", text: label });
        };
        const hasJournal = stats.journalDates.size > 0;
        if (t.vaultCount) fact("in vault", st ? `${st.total}` : "0");
        if (t.lastLogged && hasJournal) fact("last logged", st?.lastDate ? daysAgo(st.lastDate, today) : "never");
        if (t.frequency && hasJournal) fact("days of last 30", st ? String(daysLoggedWithin(st.days, today, 30)) : "0");
        if (t.streaks && hasJournal && st) {
            const { current, longest } = streaks(st.days, today);
            fact("streak", current > 0 ? `${current}d` : "—");
            fact("best streak", longest > 0 ? `${longest}d` : "—");
        }
        if (t.inserted) fact("inserted", s.useCount ? `${s.useCount}×` : s.lastUsed ? "yes" : "never");

        if (t.frequency && hasJournal && st) {
            const bars = card.createDiv({
                cls: "symbol-atlas-bars is-large",
                attr: { role: "img", "aria-label": `Days logged per week, last ${FREQUENCY_WEEKS} weeks` },
            });
            weeklyDays(st.days, today, FREQUENCY_WEEKS).forEach((n, i) => {
                const weeksAgo = FREQUENCY_WEEKS - 1 - i;
                const when = weeksAgo === 0 ? "Last 7 days" : `${weeksAgo} week${weeksAgo === 1 ? "" : "s"} earlier`;
                const bar = bars.createDiv({
                    cls: "symbol-atlas-bar",
                    attr: { "aria-label": `${when}: ${n} day${n === 1 ? "" : "s"}` },
                });
                bar.createDiv({ cls: "symbol-atlas-bar-fill" }).style.height = `${n === 0 ? 0 : Math.max(10, (n / 7) * 100)}%`;
            });
        }

        const notes: string[] = [];
        if (t.weekday && st) {
            const lean = weekdayLean(st.days);
            if (lean) notes.push(`Mostly ${WEEKDAYS[lean.weekday]}s (${Math.round(lean.share * 100)}% of days)`);
        }
        if (t.inserted && s.lastUsed) notes.push(`Last inserted ${formatRelative(s.lastUsed)}`);
        if (t.vaultCount && st && st.total > 0) notes.push(`In ${st.notes} note${st.notes === 1 ? "" : "s"}`);
        if (notes.length > 0) card.createDiv({ cls: "symbol-atlas-meta", text: notes.join(" · ") });

        if (t.recentEntries && st && st.recent.length > 0) {
            const list = card.createDiv({ cls: "symbol-atlas-entries" });
            for (const e of st.recent.slice(0, this.plugin.settings.recentEntriesCount)) {
                this.renderEntry(list, e, today);
            }
        }
    }

    private renderEntry(list: HTMLElement, e: Entry, today: string) {
        const item = list.createDiv({ cls: "symbol-atlas-entry" });
        const date = item.createEl("a", {
            cls: "symbol-atlas-entry-date",
            text: formatShortDate(e.date, today),
            href: "#",
            attr: { "aria-label": `Open ${e.path.replace(/\.md$/, "")}` },
        });
        date.addEventListener("click", (evt) => {
            evt.preventDefault();
            openNote(this.app, e.path, e.line, "tab");
        });
        item.createSpan({ cls: "symbol-atlas-entry-text", text: e.text || "—" });
    }
}
