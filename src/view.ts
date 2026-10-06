import { ItemView, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type SymbolAtlasPlugin from "../main";
import {
    OccurrenceCounts,
    SymbolEntry,
    computeUsageStats,
    formatRelative,
    getEmojiNames,
} from "./core";

export const VIEW_TYPE_SYMBOL_ATLAS = "symbol-atlas-view";

type ListSort = "recent" | "alpha" | "most-used" | "vault";

// Right-sidebar tab: usage statistics at the top, then the full symbol list.
// Tapping a row inserts that symbol into the most recently active note.
export class SymbolAtlasView extends ItemView {
    plugin: SymbolAtlasPlugin;
    private query = "";
    private sort: ListSort;
    // Rebuilt on every refresh. The search box lives outside these so typing
    // in it never loses focus when a background sync re-renders the view.
    private statsEl: HTMLElement;
    private listEl: HTMLElement;
    private syncSubtitleToggle: (() => void) | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SymbolAtlasPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.sort = plugin.settings.sortMode;
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

        this.statsEl = root.createDiv({ cls: "symbol-atlas-stats" });

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
            ["recent", "Recent"],
            ["alpha", "A–Z"],
            ["most-used", "Most used"],
            ["vault", "In vault"],
        ];
        for (const [value, label] of sortOptions) {
            sortSelect.createEl("option", { value, text: label });
        }
        sortSelect.value = this.sort;
        sortSelect.addEventListener("change", () => {
            this.sort = sortSelect.value as ListSort;
            this.renderList();
        });

        const subtitleToggle = controls.createDiv({ cls: "clickable-icon symbol-atlas-subtitle-toggle" });
        const syncToggle = () => {
            const shown = this.plugin.settings.sidebarShowSubtitles;
            setIcon(subtitleToggle, shown ? "eye" : "eye-off");
            subtitleToggle.setAttribute("aria-label", shown ? "Hide descriptions" : "Show descriptions");
            subtitleToggle.toggleClass("is-active", !shown);
        };
        syncToggle();
        subtitleToggle.addEventListener("click", async () => {
            this.plugin.settings.sidebarShowSubtitles = !this.plugin.settings.sidebarShowSubtitles;
            syncToggle();
            await this.plugin.saveSettings();
        });
        this.syncSubtitleToggle = syncToggle;

        this.listEl = root.createDiv({ cls: "symbol-atlas-list" });
        this.refresh();
    }

    async onClose() {
        this.contentEl.empty();
    }

    refresh() {
        if (!this.statsEl || !this.listEl) return;
        this.syncSubtitleToggle?.();
        this.renderStats();
        this.renderList();
    }

    private renderStats() {
        const el = this.statsEl;
        el.empty();
        const { settings } = this.plugin;
        const stats = computeUsageStats(settings.symbols);

        const tiles = el.createDiv({ cls: "symbol-atlas-tiles" });
        const tile = (value: number | string, label: string) => {
            const t = tiles.createDiv({ cls: "symbol-atlas-tile" });
            t.createDiv({ cls: "symbol-atlas-tile-value", text: String(value) });
            t.createDiv({ cls: "symbol-atlas-tile-label", text: label });
        };
        tile(stats.symbolCount, "symbols");
        tile(stats.totalInsertions, "insertions");
        tile(stats.usedCount, "used");
        tile(stats.neverUsedCount, "never used");

        if (stats.mostUsed.length > 0) {
            const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
            row.createSpan({ cls: "symbol-atlas-chip-label", text: "Top" });
            for (const s of stats.mostUsed) {
                this.chip(row, s, `${s.useCount}×`);
            }
        }

        // Vault occurrence counts are expensive (they read every note), so
        // they're only computed when asked for and kept in memory after.
        const scan = this.plugin.vaultScan;
        if (scan) {
            const top = settings.symbols
                .map((s) => ({ s, c: scan.counts.get(s.id)?.total ?? 0 }))
                .filter((x) => x.c > 0)
                .sort((a, b) => b.c - a.c)
                .slice(0, 5);
            if (top.length > 0) {
                const row = el.createDiv({ cls: "symbol-atlas-chip-row" });
                row.createSpan({ cls: "symbol-atlas-chip-label", text: "In vault" });
                for (const { s, c } of top) this.chip(row, s, String(c));
            }
        }
        const scanRow = el.createDiv({ cls: "symbol-atlas-scan-row" });
        if (scan) {
            scanRow.createSpan({
                cls: "symbol-atlas-meta",
                text: `Scanned ${scan.noteCount} notes ${formatRelative(scan.scannedAt)}`,
            });
        } else {
            scanRow.createSpan({
                cls: "symbol-atlas-meta",
                text: "Count how often each symbol appears in your notes.",
            });
        }
        const scanBtn = scanRow.createEl("button", {
            text: this.plugin.vaultScanInProgress
                ? "Scanning…"
                : scan
                ? "Rescan"
                : "Scan vault",
        });
        scanBtn.disabled = this.plugin.vaultScanInProgress;
        scanBtn.addEventListener("click", async () => {
            await this.plugin.scanVault();
        });

        const source = el.createDiv({ cls: "symbol-atlas-meta symbol-atlas-source" });
        if (settings.symbolSource === "note" && settings.noteSourcePath) {
            source.appendText("Source: ");
            const link = source.createEl("a", {
                text: `${settings.noteSourcePath} › ${settings.noteSourceHeading || "?"}`,
                href: "#",
            });
            link.addEventListener("click", (evt) => {
                evt.preventDefault();
                this.app.workspace.openLinkText(settings.noteSourcePath, "", false);
            });
            if (settings.noteSourceLastSynced) {
                source.appendText(` · synced ${formatRelative(settings.noteSourceLastSynced)}`);
            }
        } else {
            source.setText("Source: manual list (edit in settings)");
        }
    }

    // Display-only: the tooltip names the symbol, but tapping a chip does
    // nothing (inserting is what the list below is for).
    private chip(parent: HTMLElement, s: SymbolEntry, count: string) {
        const chip = parent.createSpan({
            cls: "symbol-atlas-chip",
            attr: { "aria-label": s.name },
        });
        chip.createSpan({ text: s.emoji });
        chip.createSpan({ cls: "symbol-atlas-chip-count", text: count });
    }

    private sortedFiltered(): SymbolEntry[] {
        const scan = this.plugin.vaultScan;
        const q = this.query.trim().toLowerCase();
        const symbols = this.plugin.settings.symbols.filter((s) => {
            if (!q) return true;
            const hay = `${s.emoji} ${s.name} ${s.subtitle ?? ""} ${getEmojiNames(s.emoji)}`;
            return hay.toLowerCase().includes(q);
        });
        const byName = (a: SymbolEntry, b: SymbolEntry) => a.name.localeCompare(b.name);
        const keyed = (key: (s: SymbolEntry) => number) => (a: SymbolEntry, b: SymbolEntry) =>
            key(b) - key(a) || byName(a, b);
        switch (this.sort) {
            case "alpha":
                return symbols.sort(byName);
            case "most-used":
                return symbols.sort(keyed((s) => s.useCount ?? 0));
            case "vault":
                return symbols.sort(keyed((s) => scan?.counts.get(s.id)?.total ?? 0));
            default:
                return symbols.sort(keyed((s) => s.lastUsed ?? 0));
        }
    }

    private renderList() {
        const el = this.listEl;
        el.empty();
        const symbols = this.sortedFiltered();
        if (symbols.length === 0) {
            el.createDiv({
                cls: "symbol-atlas-empty",
                text: this.query ? "No symbols match." : "No symbols yet.",
            });
            return;
        }
        const scan = this.plugin.vaultScan;
        for (const s of symbols) {
            const row = el.createDiv({
                cls: "symbol-atlas-row",
                attr: { role: "button", tabindex: "0", "aria-label": `Insert ${s.emoji} ${s.name}` },
            });
            row.createSpan({ cls: "symbol-atlas-emoji", text: s.emoji });
            const text = row.createDiv({ cls: "symbol-atlas-text" });
            text.createDiv({ cls: "symbol-atlas-name", text: s.name });
            if (s.subtitle && this.plugin.settings.sidebarShowSubtitles) {
                text.createDiv({ cls: "symbol-atlas-subtitle", text: s.subtitle });
            }
            text.createDiv({ cls: "symbol-atlas-meta", text: this.describeUsage(s, scan?.counts.get(s.id)) });

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
                if (evt.key === "Enter" || evt.key === " ") {
                    evt.preventDefault();
                    this.insert(s);
                }
            });
        }
    }

    private describeUsage(s: SymbolEntry, vault: OccurrenceCounts | undefined): string {
        const parts: string[] = [];
        if (s.useCount) parts.push(`inserted ${s.useCount}×`);
        if (s.lastUsed) parts.push(`last inserted ${formatRelative(s.lastUsed)}`);
        if (parts.length === 0) parts.push("never inserted");
        if (vault) {
            parts.push(
                vault.total > 0
                    ? `${vault.total} in vault (${vault.notes} note${vault.notes === 1 ? "" : "s"})`
                    : "not in vault"
            );
        }
        return parts.join(" · ");
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
