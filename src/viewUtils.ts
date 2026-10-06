// Small DOM/navigation helpers shared by the sidebar and the stats page.
import { App, PaneType, TFile } from "obsidian";
import type SymbolAtlasPlugin from "../main";
import type { SymbolEntry } from "./core";
import { dayNumber, symbolKey } from "./stats";

// Display-only symbol + count chip; the tooltip names the symbol.
export function chip(parent: HTMLElement, s: SymbolEntry, count?: string): HTMLElement {
    const el = parent.createSpan({ cls: "symbol-atlas-chip", attr: { "aria-label": s.name } });
    el.createSpan({ text: s.emoji });
    if (count !== undefined) el.createSpan({ cls: "symbol-atlas-chip-count", text: count });
    return el;
}

export function symbolForKey(plugin: SymbolAtlasPlugin, key: string): SymbolEntry | undefined {
    return plugin.settings.symbols.find((s) => symbolKey(s.emoji) === key);
}

export function daysAgo(date: string, today: string): string {
    const n = dayNumber(today) - dayNumber(date);
    if (n <= 0) return "today";
    if (n === 1) return "yesterday";
    return `${n}d ago`;
}

export function openNote(app: App, path: string, line?: number, where: PaneType | false = false) {
    const file = app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) return;
    app.workspace.getLeaf(where).openFile(file, line === undefined ? undefined : { eState: { line } });
}

export function settingsLink(plugin: SymbolAtlasPlugin, parent: HTMLElement, text: string) {
    const a = parent.createEl("a", { text, href: "#" });
    a.addEventListener("click", (evt) => {
        evt.preventDefault();
        plugin.openSettings();
    });
}
