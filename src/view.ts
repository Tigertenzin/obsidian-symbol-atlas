import { ItemView, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type SymbolAtlasPlugin from "../main";
import { SymbolEntry, getEmojiNames } from "./core";
import { JournalStats, dayNumber, localToday, symbolKey } from "./stats";
import { chip, daysAgo } from "./viewUtils";

export const VIEW_TYPE_SYMBOL_ATLAS = "symbol-atlas-view";

function graphemeCount(s: string): number {
    const Segmenter = (Intl as any).Segmenter;
    if (Segmenter) return Array.from(new Segmenter("en", { granularity: "grapheme" }).segment(s)).length;
    return Array.from(s.replace(/\uFE0F|\u200D./gu, "")).length;
}

type ListSort = "recent" | "alpha" | "logged" | "vault";
export type SidebarLayout = "list" | "grid";

// Right-sidebar tab, kept light: a few broad numbers, a button to the full
// stats page, and the symbols as quick-insert rows or a grid of buttons.
// Tapping a symbol inserts it into the most recently active note.
export class SymbolAtlasView extends ItemView {
    plugin: SymbolAtlasPlugin;
    private query = "";
    private sort: ListSort;
    // Descriptions and layout start from the settings defaults; the buttons
    // next to the filter change them for this view only.
    private showSubtitles: boolean;
    private layout: SidebarLayout;
    private defaults: { subtitles: boolean; layout: SidebarLayout };
    // Rebuilt on every refresh. The search box lives outside these so typing
    // in it never loses focus when a background update re-renders the view.
    private topEl: HTMLElement;
    private listEl: HTMLElement;
    private subtitleToggle: HTMLElement;
    private layoutToggle: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: SymbolAtlasPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.sort = plugin.settings.sortMode;
        this.defaults = {
            subtitles: plugin.settings.sidebarShowSubtitles,
            layout: plugin.settings.sidebarLayout,
        };
        this.showSubtitles = this.defaults.subtitles;
        this.layout = this.defaults.layout;
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
            attr: { placeholder: "Filter…", "aria-label": "Filter symbols" },
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
            ["recent", "Recent"],
            ["alpha", "A–Z"],
            ["vault", "Most logged"],
            ["logged", "Last logged"],
        ];
        for (const [value, label] of sortOptions) {
            sortSelect.createEl("option", { value, text: label });
        }
        sortSelect.value = this.sort === "recent" || this.sort === "alpha" ? this.sort : "recent";
        sortSelect.addEventListener("change", () => {
            this.sort = sortSelect.value as ListSort;
            this.renderList();
        });

        this.layoutToggle = controls.createDiv({ cls: "clickable-icon" });
        this.layoutToggle.addEventListener("click", () => {
            this.layout = this.layout === "list" ? "grid" : "list";
            this.renderList();
        });
        this.subtitleToggle = controls.createDiv({ cls: "clickable-icon" });
        this.subtitleToggle.addEventListener("click", () => {
            this.showSubtitles = !this.showSubtitles;
            this.renderList();
        });

        this.listEl = root.createDiv();
        this.refresh();
    }

    async onClose() {
        this.contentEl.empty();
    }

    refresh() {
        if (!this.topEl || !this.listEl) return;
        // Changed defaults in settings reset the per-view toggles.
        const { sidebarShowSubtitles, sidebarLayout } = this.plugin.settings;
        if (sidebarShowSubtitles !== this.defaults.subtitles) {
            this.defaults.subtitles = sidebarShowSubtitles;
            this.showSubtitles = sidebarShowSubtitles;
        }
        if (sidebarLayout !== this.defaults.layout) {
            this.defaults.layout = sidebarLayout;
            this.layout = sidebarLayout;
        }
        this.renderTop();
        this.renderList();
    }

    private renderTop() {
        const el = this.topEl;
        el.empty();
        const { settings, index } = this.plugin;
        const stats = this.plugin.getStats();
        const today = localToday();

        if (settings.sidebarOverview) {
            let entries = 0;
            for (const s of stats.bySymbol.values()) entries += s.total;
            const tiles = el.createDiv({ cls: "symbol-atlas-tiles" });
            const tile = (value: number, label: string, tip: string) => {
                const t = tiles.createDiv({ cls: "symbol-atlas-tile", attr: { "aria-label": tip } });
                t.createDiv({ cls: "symbol-atlas-tile-value", text: value.toLocaleString() });
                t.createDiv({ cls: "symbol-atlas-tile-label", text: label });
            };
            tile(settings.symbols.length, "symbols", "Symbols in your atlas");
            tile(entries, "entries", "Times atlas symbols appear in your notes");
            if (stats.journalDates.size > 0) {
                tile(this.loggedThisWeek(stats, today), "this week", "Entries in daily notes over the last 7 days");
                tile(stats.journalDates.size, "journal days", "Daily notes found");
            } else {
                const insertions = settings.symbols.reduce((sum, s) => sum + (s.useCount ?? 0), 0);
                tile(insertions, "insertions", "Symbols inserted with the picker or sidebar");
                tile(index.noteCount, "notes", "Notes indexed");
            }

            const todays = stats.daySymbols.get(today);
            if (stats.journalDates.has(today)) {
                const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
                row.createSpan({ cls: "symbol-atlas-chip-label", text: "Today" });
                const logged = settings.symbols.filter((s) => todays?.has(symbolKey(s.emoji)));
                if (logged.length === 0) row.createSpan({ cls: "symbol-atlas-meta", text: "nothing logged yet" });
                for (const s of logged) chip(row, s);
            }
        }

        const open = el.createEl("button", { cls: "symbol-atlas-open-stats" });
        setIcon(open.createSpan(), "bar-chart-3");
        open.createSpan({ text: "Open stats" });
        open.addEventListener("click", () => this.plugin.openStatsPage());
    }

    private loggedThisWeek(stats: JournalStats, today: string): number {
        const end = dayNumber(today);
        let n = 0;
        for (const [date, count] of stats.dayTotals) {
            const ago = end - dayNumber(date);
            if (ago >= 0 && ago < 7) n += count;
        }
        return n;
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
            case "vault":
                return symbols.sort(keyed((s) => st(s)?.total ?? 0));
            case "logged":
                return symbols.sort(keyed((s) => (st(s)?.lastDate ? dayNumber(st(s)!.lastDate!) : 0)));
            default:
                return symbols.sort(keyed((s) => s.lastUsed ?? 0));
        }
    }

    private renderList() {
        const el = this.listEl;
        el.empty();

        setIcon(this.layoutToggle, this.layout === "list" ? "layout-grid" : "list");
        this.layoutToggle.setAttribute("aria-label", this.layout === "list" ? "Show as grid" : "Show as list");
        setIcon(this.subtitleToggle, this.showSubtitles ? "eye" : "eye-off");
        this.subtitleToggle.setAttribute("aria-label", this.showSubtitles ? "Hide descriptions" : "Show descriptions");
        this.subtitleToggle.toggleClass("is-active", !this.showSubtitles);
        this.subtitleToggle.toggle(this.layout === "list");

        const stats = this.plugin.getStats();
        const symbols = this.sortedFiltered(stats);
        if (symbols.length === 0) {
            el.createDiv({
                cls: "symbol-atlas-empty",
                text: this.query ? "No symbols match." : "No symbols yet.",
            });
            return;
        }
        if (this.layout === "grid") this.renderGrid(el, symbols);
        else this.renderRows(el, symbols, stats);
    }

    private renderGrid(el: HTMLElement, symbols: SymbolEntry[]) {
        el.className = "symbol-atlas-grid";
        for (const s of symbols) {
            const btn = el.createEl("button", {
                cls: "symbol-atlas-grid-btn",
                text: s.emoji,
                attr: { "aria-label": s.subtitle ? `${s.name}\n${s.subtitle}` : s.name },
            });
            // Combos like 🧠📺 get a double-width button.
            if (graphemeCount(s.emoji) > 1) btn.addClass("is-multi");
            btn.addEventListener("click", () => this.insert(s));
        }
    }

    private renderRows(el: HTMLElement, symbols: SymbolEntry[], stats: JournalStats) {
        el.className = "symbol-atlas-list";
        const today = localToday();
        const summary = this.plugin.settings.sidebarSummary && this.plugin.index.ready;
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
            if (summary) {
                const st = stats.bySymbol.get(symbolKey(s.emoji));
                const parts = [`${st?.total ?? 0}×`];
                if (stats.journalDates.size > 0) {
                    parts.push(st?.lastDate ? `last ${daysAgo(st.lastDate, today)}` : "never logged");
                }
                text.createDiv({ cls: "symbol-atlas-meta", text: parts.join(" · ") });
            }

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

    private async insert(s: SymbolEntry) {
        const inserted = await this.plugin.insertIntoLastEditor(s);
        // The sidebar is a full-screen drawer on phones; get it out of the
        // way so the user sees what was just inserted.
        const inRightSidebar = this.leaf.getRoot() === this.app.workspace.rightSplit;
        if (inserted && Platform.isPhone && inRightSidebar) {
            this.app.workspace.rightSplit.collapse();
        }
    }
}
