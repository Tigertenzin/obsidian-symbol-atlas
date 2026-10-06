import { ItemView, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
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

export const VIEW_TYPE_SYMBOL_ATLAS = "symbol-atlas-view";

type ListSort = "recent" | "alpha" | "most-used" | "vault" | "logged";

const HEATMAP_WEEKS = 26;
const FREQUENCY_WEEKS = 8;
const UPKEEP_LIMIT = 8;

// Right-sidebar tab: overview, journal statistics and upkeep at the top,
// then the full symbol list. Tapping a row inserts that symbol into the most
// recently active note.
export class SymbolAtlasView extends ItemView {
    plugin: SymbolAtlasPlugin;
    private query = "";
    private sort: ListSort;
    // Descriptions start from the settings default; the eye button toggles
    // them for this view only.
    private showSubtitles: boolean;
    private subtitleDefault: boolean;
    private heatmapSymbol = ""; // symbolKey, or "" for all symbols
    private openSections = new Set(["journal", "upkeep"]);
    // Rebuilt on every refresh. The search box lives outside these so typing
    // in it never loses focus when a background update re-renders the view.
    private topEl: HTMLElement;
    private listEl: HTMLElement;
    private subtitleToggle: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: SymbolAtlasPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.sort = plugin.settings.sortMode;
        this.subtitleDefault = plugin.settings.sidebarShowSubtitles;
        this.showSubtitles = this.subtitleDefault;
    }

    getViewType(): string {
        return VIEW_TYPE_SYMBOL_ATLAS;
    }

    getDisplayText(): string {
        return "Symbol Atlas";
    }

    getIcon(): string {
        return "map";
    }

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass("symbol-atlas-view");

        this.topEl = root.createDiv({ cls: "symbol-atlas-top" });

        const controls = root.createDiv({ cls: "symbol-atlas-controls" });
        const search = controls.createEl("input", {
            type: "search",
            cls: "symbol-atlas-search",
            attr: { placeholder: "Filter symbols…", "aria-label": "Filter symbols" },
        });
        search.value = this.query;
        search.addEventListener("input", () => {
            this.query = search.value;
            this.renderList();
        });

        const sortSelect = controls.createEl("select", {
            cls: "dropdown symbol-atlas-sort",
            attr: { "aria-label": "Sort symbols" },
        });
        const sortOptions: [ListSort, string][] = [
            ["recent", "Recently inserted"],
            ["logged", "Recently logged"],
            ["alpha", "A–Z"],
            ["most-used", "Most inserted"],
            ["vault", "Most logged"],
        ];
        for (const [value, label] of sortOptions) {
            sortSelect.createEl("option", { value, text: label });
        }
        sortSelect.value = this.sort;
        sortSelect.addEventListener("change", () => {
            this.sort = sortSelect.value as ListSort;
            this.renderList();
        });

        this.subtitleToggle = controls.createDiv({ cls: "clickable-icon symbol-atlas-subtitle-toggle" });
        this.subtitleToggle.addEventListener("click", () => {
            this.showSubtitles = !this.showSubtitles;
            this.renderList();
        });

        this.listEl = root.createDiv({ cls: "symbol-atlas-list" });
        this.refresh();
    }

    async onClose() {
        this.contentEl.empty();
    }

    refresh() {
        if (!this.topEl || !this.listEl) return;
        // A changed default in settings resets the per-view toggle.
        const def = this.plugin.settings.sidebarShowSubtitles;
        if (def !== this.subtitleDefault) {
            this.subtitleDefault = def;
            this.showSubtitles = def;
        }
        this.renderTop();
        this.renderList();
    }

    // ---------------------------------------------------------------------
    // Top: overview, journal, upkeep, index status
    // ---------------------------------------------------------------------

    private renderTop() {
        const el = this.topEl;
        el.empty();
        const { settings } = this.plugin;
        const stats = this.plugin.getStats();
        const today = localToday();
        const js = settings.journalStats;

        if (js.overview) this.renderOverview(el, stats);
        if (js.top) this.renderTopChips(el, stats);
        if (js.heatmap || js.trend || js.coverage || js.together) {
            this.section(el, "journal", "Journal", (body) => this.renderJournal(body, stats, today));
        }
        if (settings.upkeep.untracked || settings.upkeep.dormant) {
            this.section(el, "upkeep", "Upkeep", (body) => this.renderUpkeep(body, stats, today));
        }
        this.renderStatus(el);
    }

    private section(parent: HTMLElement, id: string, title: string, render: (body: HTMLElement) => void) {
        const details = parent.createEl("details", { cls: "symbol-atlas-section" });
        details.open = this.openSections.has(id);
        details.createEl("summary", { text: title });
        details.addEventListener("toggle", () => {
            if (details.open) this.openSections.add(id);
            else this.openSections.delete(id);
        });
        render(details.createDiv({ cls: "symbol-atlas-section-body" }));
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
            .slice(0, 5);
        if (logged.length > 0) {
            const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
            row.createSpan({ cls: "symbol-atlas-chip-label", text: "Most logged" });
            for (const { s, n } of logged) this.chip(row, s, String(n));
        }
        const inserted = symbols
            .filter((s) => (s.useCount ?? 0) > 0)
            .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
            .slice(0, 5);
        if (inserted.length > 0) {
            const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
            row.createSpan({ cls: "symbol-atlas-chip-label", text: "Most inserted" });
            for (const s of inserted) this.chip(row, s, `${s.useCount}×`);
        }
    }

    // Display-only: the tooltip names the symbol, but tapping a chip does
    // nothing (inserting is what the list below is for).
    private chip(parent: HTMLElement, s: SymbolEntry, count: string) {
        const chip = parent.createSpan({ cls: "symbol-atlas-chip", attr: { "aria-label": s.name } });
        chip.createSpan({ text: s.emoji });
        chip.createSpan({ cls: "symbol-atlas-chip-count", text: count });
    }

    private renderJournal(body: HTMLElement, stats: JournalStats, today: string) {
        const { settings } = this.plugin;
        if (stats.journalDates.size === 0) {
            const hint = body.createDiv({ cls: "symbol-atlas-meta" });
            const where = settings.journalFolder ? `in "${settings.journalFolder}"` : "in your vault";
            hint.appendText(
                this.plugin.index.ready
                    ? `No daily notes ${where} match the filename format "${settings.journalDateFormat}". `
                    : "Indexing notes… "
            );
            if (this.plugin.index.ready) {
                this.settingsLink(hint, "Set the journal folder and format in settings.");
            }
            return;
        }
        const js = settings.journalStats;
        if (js.heatmap) this.renderHeatmap(body, stats, today);
        if (js.trend) this.renderTrend(body, stats, today);
        if (js.coverage) this.renderCoverage(body, stats, today);
        if (js.together) this.renderTogether(body, stats);
    }

    private renderHeatmap(body: HTMLElement, stats: JournalStats, today: string) {
        const block = body.createDiv({ cls: "symbol-atlas-block" });
        const head = block.createDiv({ cls: "symbol-atlas-block-head" });
        head.createSpan({ cls: "symbol-atlas-block-title", text: "Activity" });
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
        const weeks = heatmapWeeks(counts, today, HEATMAP_WEEKS);
        let max = 0;
        for (const col of weeks) for (const c of col) if (c) max = Math.max(max, c.count);

        const grid = block.createDiv({
            cls: "symbol-atlas-heatmap",
            attr: { role: "img", "aria-label": `Entries per day over the last ${HEATMAP_WEEKS} weeks` },
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
        const legend = block.createDiv({ cls: "symbol-atlas-heat-legend symbol-atlas-meta" });
        legend.createSpan({ text: `${formatShortDate(weeks[0][0]!.date, today)} – today` });
        const scale = legend.createSpan({ cls: "symbol-atlas-heat-scale" });
        scale.createSpan({ text: "Less" });
        for (let l = 0; l <= 4; l++) {
            scale.createDiv({ cls: "symbol-atlas-heat-cell", attr: { "data-level": String(l) } });
        }
        scale.createSpan({ text: "More" });
    }

    private renderTrend(body: HTMLElement, stats: JournalStats, today: string) {
        const changes = compareWindows(stats, today, 30);
        const block = body.createDiv({ cls: "symbol-atlas-block" });
        block.createDiv({ cls: "symbol-atlas-block-title", text: "Last 30 days vs the 30 before" });
        if (changes.length === 0) {
            block.createDiv({ cls: "symbol-atlas-meta", text: "No change." });
            return;
        }
        for (const ch of changes) {
            const s = this.symbolForKey(ch.key);
            const row = block.createDiv({ cls: "symbol-atlas-stat-row" });
            row.createSpan({ cls: "symbol-atlas-stat-emoji", text: s?.emoji ?? ch.key });
            row.createSpan({ cls: "symbol-atlas-stat-name", text: s?.name ?? "" });
            const up = ch.after > ch.before;
            row.createSpan({
                cls: "symbol-atlas-stat-value",
                text: `${ch.before} → ${ch.after} ${up ? "↑" : "↓"}`,
                attr: { "aria-label": `${ch.before} entries before, ${ch.after} in the last 30 days` },
            });
        }
    }

    private renderCoverage(body: HTMLElement, stats: JournalStats, today: string) {
        const block = body.createDiv({ cls: "symbol-atlas-block" });
        block.createDiv({ cls: "symbol-atlas-block-title", text: "Coverage" });
        const line = (label: string, span?: number) => {
            const c = coverage(stats, today, span);
            if (c.journalDays === 0) return;
            const pct = Math.round((c.daysWithSymbols / c.journalDays) * 100);
            const perDay = c.perDay.toFixed(1);
            const row = block.createDiv({ cls: "symbol-atlas-stat-row" });
            row.createSpan({ cls: "symbol-atlas-stat-name", text: label });
            row.createSpan({
                cls: "symbol-atlas-stat-value",
                text: `${c.daysWithSymbols}/${c.journalDays} days (${pct}%) · ${perDay}/day`,
                attr: {
                    "aria-label": `${c.daysWithSymbols} of ${c.journalDays} daily notes have symbols; ${perDay} entries per daily note on average`,
                },
            });
        };
        line("Last 30 days", 30);
        line("All time");
    }

    private renderTogether(body: HTMLElement, stats: JournalStats) {
        const pairs = coOccurrences(stats);
        const block = body.createDiv({ cls: "symbol-atlas-block" });
        block.createDiv({ cls: "symbol-atlas-block-title", text: "Often logged together" });
        if (pairs.length === 0) {
            block.createDiv({ cls: "symbol-atlas-meta", text: "Not enough overlap yet." });
            return;
        }
        for (const p of pairs) {
            const a = this.symbolForKey(p.a);
            const b = this.symbolForKey(p.b);
            const row = block.createDiv({
                cls: "symbol-atlas-stat-row",
                attr: { "aria-label": `${a?.name ?? p.a} + ${b?.name ?? p.b}` },
            });
            row.createSpan({ cls: "symbol-atlas-stat-emoji", text: `${a?.emoji ?? p.a} + ${b?.emoji ?? p.b}` });
            row.createSpan({ cls: "symbol-atlas-stat-name" });
            row.createSpan({ cls: "symbol-atlas-stat-value", text: `${p.days} days` });
        }
    }

    private renderUpkeep(body: HTMLElement, stats: JournalStats, today: string) {
        const { settings } = this.plugin;
        if (settings.upkeep.untracked) {
            const block = body.createDiv({ cls: "symbol-atlas-block" });
            block.createDiv({ cls: "symbol-atlas-block-title", text: "Untracked symbols" });
            if (!settings.symbolSuffix.trim()) {
                block.createDiv({
                    cls: "symbol-atlas-meta",
                    text: 'Set "Text to insert after each symbol" (e.g. "::") in settings to spot symbols used in notes but missing from your atlas.',
                });
            } else if (stats.untracked.length === 0) {
                block.createDiv({ cls: "symbol-atlas-meta", text: "Every symbol in your notes is in the atlas." });
            } else {
                for (const u of stats.untracked.slice(0, UPKEEP_LIMIT)) {
                    const row = block.createDiv({ cls: "symbol-atlas-stat-row" });
                    row.createSpan({ cls: "symbol-atlas-stat-emoji", text: u.display });
                    const where = row.createSpan({ cls: "symbol-atlas-stat-name symbol-atlas-meta" });
                    where.appendText(`${u.total}× in ${u.notes} note${u.notes === 1 ? "" : "s"} · `);
                    const link = where.createEl("a", {
                        text: u.lastDate ? formatShortDate(u.lastDate, today) : u.lastPath.replace(/\.md$/, ""),
                        href: "#",
                        attr: { "aria-label": `Open ${u.lastPath.replace(/\.md$/, "")}` },
                    });
                    link.addEventListener("click", (evt) => {
                        evt.preventDefault();
                        this.openNote(u.lastPath);
                    });
                    const add = row.createDiv({
                        cls: "clickable-icon",
                        attr: {
                            "aria-label":
                                settings.symbolSource === "note" ? "Open the source note to add it" : "Add to atlas",
                        },
                    });
                    setIcon(add, "plus");
                    add.addEventListener("click", () => this.plugin.addSymbolFromToken(u.display));
                }
                if (stats.untracked.length > UPKEEP_LIMIT) {
                    block.createDiv({
                        cls: "symbol-atlas-meta",
                        text: `…and ${stats.untracked.length - UPKEEP_LIMIT} more`,
                    });
                }
            }
        }

        if (settings.upkeep.dormant) {
            const block = body.createDiv({ cls: "symbol-atlas-block" });
            block.createDiv({
                cls: "symbol-atlas-block-title",
                text: `Not logged in ${settings.dormantDays}+ days`,
            });
            if (stats.journalDates.size === 0) {
                const hint = block.createDiv({ cls: "symbol-atlas-meta" });
                this.settingsLink(hint, "Needs daily notes: set the journal folder and format in settings.");
            } else {
                const dormant = dormantSymbols(stats, settings.symbols, today, settings.dormantDays);
                if (dormant.length === 0) {
                    block.createDiv({ cls: "symbol-atlas-meta", text: "Every symbol has been logged recently." });
                }
                for (const { symbol, lastDate } of dormant.slice(0, UPKEEP_LIMIT)) {
                    const row = block.createDiv({ cls: "symbol-atlas-stat-row" });
                    row.createSpan({ cls: "symbol-atlas-stat-emoji", text: symbol.emoji });
                    row.createSpan({ cls: "symbol-atlas-stat-name", text: symbol.name });
                    row.createSpan({
                        cls: "symbol-atlas-stat-value",
                        text: lastDate ? formatShortDate(lastDate, today) : "never",
                    });
                }
                if (dormant.length > UPKEEP_LIMIT) {
                    block.createDiv({ cls: "symbol-atlas-meta", text: `…and ${dormant.length - UPKEEP_LIMIT} more` });
                }
            }
        }
    }

    private renderStatus(el: HTMLElement) {
        const { settings, index } = this.plugin;
        const status = el.createDiv({ cls: "symbol-atlas-status symbol-atlas-meta" });
        const text = status.createSpan();
        if (index.building) {
            text.setText(`Indexing notes… ${index.progress.done}/${index.progress.total}`);
        } else if (index.ready) {
            text.setText(`${index.noteCount.toLocaleString()} notes indexed`);
        } else {
            text.setText("Loading index…");
        }
        const rebuild = status.createDiv({
            cls: "clickable-icon",
            attr: { "aria-label": "Rebuild the index from scratch" },
        });
        setIcon(rebuild, "refresh-cw");
        rebuild.addEventListener("click", () => this.plugin.rebuildIndex());

        const source = el.createDiv({ cls: "symbol-atlas-meta symbol-atlas-source" });
        if (settings.symbolSource === "note" && settings.noteSourcePath) {
            source.appendText("Source: ");
            const link = source.createEl("a", {
                text: `${settings.noteSourcePath} › ${settings.noteSourceHeading || "?"}`,
                href: "#",
            });
            link.addEventListener("click", (evt) => {
                evt.preventDefault();
                this.openNote(settings.noteSourcePath);
            });
            if (settings.noteSourceLastSynced) {
                source.appendText(` · synced ${formatRelative(settings.noteSourceLastSynced)}`);
            }
        } else {
            source.setText("Source: manual list (edit in settings)");
        }
    }

    private settingsLink(parent: HTMLElement, text: string) {
        const a = parent.createEl("a", { text, href: "#" });
        a.addEventListener("click", (evt) => {
            evt.preventDefault();
            // Undocumented but long-standing API for opening a settings tab.
            const setting = (this.app as any).setting;
            setting?.open();
            setting?.openTabById(this.plugin.manifest.id);
        });
    }

    // ---------------------------------------------------------------------
    // List
    // ---------------------------------------------------------------------

    private symbolForKey(key: string): SymbolEntry | undefined {
        return this.plugin.settings.symbols.find((s) => symbolKey(s.emoji) === key);
    }

    private sortedFiltered(stats: JournalStats): SymbolEntry[] {
        const q = this.query.trim().toLowerCase();
        const symbols = this.plugin.settings.symbols.filter((s) => {
            if (!q) return true;
            const hay = `${s.emoji} ${s.name} ${s.subtitle ?? ""} ${getEmojiNames(s.emoji)}`;
            return hay.toLowerCase().includes(q);
        });
        const st = (s: SymbolEntry) => stats.bySymbol.get(symbolKey(s.emoji));
        const byName = (a: SymbolEntry, b: SymbolEntry) => a.name.localeCompare(b.name);
        const keyed = (key: (s: SymbolEntry) => number) => (a: SymbolEntry, b: SymbolEntry) =>
            key(b) - key(a) || byName(a, b);
        switch (this.sort) {
            case "alpha":
                return symbols.sort(byName);
            case "most-used":
                return symbols.sort(keyed((s) => s.useCount ?? 0));
            case "vault":
                return symbols.sort(keyed((s) => st(s)?.total ?? 0));
            case "logged":
                return symbols.sort(
                    keyed((s) => {
                        const d = st(s)?.lastDate;
                        return d ? dayNumber(d) : 0;
                    })
                );
            default:
                return symbols.sort(keyed((s) => s.lastUsed ?? 0));
        }
    }

    private renderList() {
        const el = this.listEl;
        el.empty();

        setIcon(this.subtitleToggle, this.showSubtitles ? "eye" : "eye-off");
        this.subtitleToggle.setAttribute("aria-label", this.showSubtitles ? "Hide descriptions" : "Show descriptions");
        this.subtitleToggle.toggleClass("is-active", !this.showSubtitles);

        const stats = this.plugin.getStats();
        const symbols = this.sortedFiltered(stats);
        if (symbols.length === 0) {
            el.createDiv({
                cls: "symbol-atlas-empty",
                text: this.query ? "No symbols match." : "No symbols yet.",
            });
            return;
        }
        const today = localToday();
        for (const s of symbols) {
            const row = el.createDiv({
                cls: "symbol-atlas-row",
                attr: { role: "button", tabindex: "0", "aria-label": `Insert ${s.emoji} ${s.name}` },
            });
            row.createSpan({ cls: "symbol-atlas-emoji", text: s.emoji });
            const text = row.createDiv({ cls: "symbol-atlas-text" });
            text.createDiv({ cls: "symbol-atlas-name", text: s.name });
            if (s.subtitle && this.showSubtitles) {
                text.createDiv({ cls: "symbol-atlas-subtitle", text: s.subtitle });
            }
            this.renderSymbolStats(text, s, stats.bySymbol.get(symbolKey(s.emoji)), stats, today);

            const copy = row.createDiv({
                cls: "clickable-icon symbol-atlas-copy",
                attr: { "aria-label": "Copy to clipboard" },
            });
            setIcon(copy, "copy");
            copy.addEventListener("click", (evt) => {
                evt.stopPropagation();
                this.plugin.copySymbol(s);
            });

            row.addEventListener("click", () => this.insert(s));
            row.addEventListener("keydown", (evt) => {
                if (evt.target === row && (evt.key === "Enter" || evt.key === " ")) {
                    evt.preventDefault();
                    this.insert(s);
                }
            });
        }
    }

    private renderSymbolStats(
        el: HTMLElement,
        s: SymbolEntry,
        st: SymbolStats | undefined,
        stats: JournalStats,
        today: string
    ) {
        const t = this.plugin.settings.symbolStats;
        const hasJournal = stats.journalDates.size > 0;
        const parts: string[] = [];
        if (t.inserted) {
            if (s.useCount) parts.push(`inserted ${s.useCount}×`);
            if (s.lastUsed) parts.push(`last inserted ${formatRelative(s.lastUsed)}`);
            if (!s.useCount && !s.lastUsed) parts.push("never inserted");
        }
        if (t.vaultCount && this.plugin.index.ready) {
            parts.push(
                st && st.total > 0
                    ? `${st.total} in vault (${st.notes} note${st.notes === 1 ? "" : "s"})`
                    : "not in vault"
            );
        }
        if (t.lastLogged && hasJournal) {
            parts.push(st?.lastDate ? `last logged ${this.daysAgo(st.lastDate, today)}` : "never logged");
        }
        if (parts.length > 0) el.createDiv({ cls: "symbol-atlas-meta", text: parts.join(" · ") });

        if (!hasJournal || !st) return;
        const days = st.days;

        if (t.frequency) {
            const line = el.createDiv({ cls: "symbol-atlas-meta symbol-atlas-freq" });
            line.createSpan({ text: `${daysLoggedWithin(days, today, 30)} of last 30 days` });
            const bars = line.createDiv({
                cls: "symbol-atlas-bars",
                attr: { role: "img", "aria-label": `Days logged per week, last ${FREQUENCY_WEEKS} weeks` },
            });
            weeklyDays(days, today, FREQUENCY_WEEKS).forEach((n, i) => {
                const weeksAgo = FREQUENCY_WEEKS - 1 - i;
                const when = weeksAgo === 0 ? "Last 7 days" : `${weeksAgo} week${weeksAgo === 1 ? "" : "s"} earlier`;
                const bar = bars.createDiv({
                    cls: "symbol-atlas-bar",
                    attr: { "aria-label": `${when}: ${n} day${n === 1 ? "" : "s"}` },
                });
                const fill = bar.createDiv({ cls: "symbol-atlas-bar-fill" });
                fill.style.height = `${n === 0 ? 0 : Math.max(15, (n / 7) * 100)}%`;
            });
        }

        const extra: string[] = [];
        if (t.streaks) {
            const { current, longest } = streaks(days, today);
            if (current > 1) extra.push(`${current}-day streak (best ${longest})`);
            else if (longest > 1) extra.push(`best streak ${longest} days`);
        }
        if (t.weekday) {
            const lean = weekdayLean(days);
            if (lean) extra.push(`mostly ${WEEKDAYS[lean.weekday]}s (${Math.round(lean.share * 100)}%)`);
        }
        if (extra.length > 0) el.createDiv({ cls: "symbol-atlas-meta", text: extra.join(" · ") });

        if (t.recentEntries && st.recent.length > 0) {
            const list = el.createDiv({ cls: "symbol-atlas-entries" });
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
            evt.stopPropagation();
            this.openNote(e.path, e.line);
        });
        item.createSpan({ cls: "symbol-atlas-entry-text", text: e.text || "—" });
    }

    private daysAgo(date: string, today: string): string {
        const n = dayNumber(today) - dayNumber(date);
        if (n <= 0) return "today";
        if (n === 1) return "yesterday";
        return `${n}d ago`;
    }

    private openNote(path: string, line?: number) {
        const file = this.app.vault.getFileByPath(path);
        if (!(file instanceof TFile)) return;
        this.app.workspace.getLeaf(false).openFile(file, line === undefined ? undefined : { eState: { line } });
        this.collapseOnPhone();
    }

    private async insert(s: SymbolEntry) {
        const inserted = await this.plugin.insertIntoLastEditor(s);
        if (inserted) this.collapseOnPhone();
    }

    // The sidebar is a full-screen drawer on phones; get it out of the way
    // so the user sees the note.
    private collapseOnPhone() {
        const inRightSidebar = this.leaf.getRoot() === this.app.workspace.rightSplit;
        if (Platform.isPhone && inRightSidebar) {
            this.app.workspace.rightSplit.collapse();
        }
    }
}
