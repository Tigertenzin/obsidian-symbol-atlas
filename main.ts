import {
    AbstractInputSuggest,
    App,
    Editor,
    EventRef,
    FuzzyMatch,
    FuzzySuggestModal,
    MarkdownView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    normalizePath,
} from "obsidian";
import {
    DEFAULT_SYMBOLS,
    OccurrenceCounts,
    SymbolEntry,
    countOccurrences,
    extractSection,
    generateId,
    getEmojiNames,
    headingMatches,
    mergeParsedSymbols,
    parseImportedSymbols,
    parseSymbolsFromLines,
    resolveNotePath,
    samePath,
} from "./src/core";
import { SymbolAtlasView, VIEW_TYPE_SYMBOL_ATLAS } from "./src/view";

type SortMode = "recent" | "alpha";
type SymbolSource = "manual" | "note";

interface SymbolAtlasSettings {
    symbols: SymbolEntry[];
    sortMode: SortMode;
    symbolSuffix: string;
    symbolSource: SymbolSource;
    noteSourcePath: string;
    noteSourceHeading: string;
    noteSourceLastSynced?: number;
    sidebarShowSubtitles: boolean;
}

const DEFAULT_SETTINGS: SymbolAtlasSettings = {
    symbols: DEFAULT_SYMBOLS,
    sortMode: "recent",
    symbolSuffix: "",
    symbolSource: "manual",
    noteSourcePath: "",
    noteSourceHeading: "",
    sidebarShowSubtitles: true,
};

// How long the startup sync waits for the source note to show up in the
// vault index before giving up and reporting it missing. Mobile vaults
// (especially iCloud-backed ones) can take a while to finish indexing.
const STARTUP_SYNC_TIMEOUT_MS = 30_000;

export interface VaultScan {
    scannedAt: number;
    noteCount: number;
    counts: Map<string, OccurrenceCounts>; // keyed by SymbolEntry.id
}

export default class SymbolAtlasPlugin extends Plugin {
    settings: SymbolAtlasSettings;
    vaultScan: VaultScan | null = null;
    vaultScanInProgress = false;
    private syncDebounceTimer: number | null = null;
    private syncInFlight = false;
    private syncQueued = false;

    async onload() {
        await this.loadSettings();

        this.registerView(
            VIEW_TYPE_SYMBOL_ATLAS,
            (leaf) => new SymbolAtlasView(leaf, this)
        );

        // Fires only once the note's cache is actually up to date (unlike
        // vault "modify", which fires before the async re-index finishes).
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                if (this.settings.symbolSource !== "note") return;
                if (!samePath(file.path, this.settings.noteSourcePath)) return;
                if (this.syncDebounceTimer !== null) {
                    window.clearTimeout(this.syncDebounceTimer);
                }
                this.syncDebounceTimer = window.setTimeout(() => {
                    this.syncDebounceTimer = null;
                    this.syncFromNote({ silent: true });
                }, 500);
            })
        );

        // Keep the configured path pointed at the note if it gets moved/renamed.
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (!samePath(this.settings.noteSourcePath, oldPath)) return;
                this.settings.noteSourcePath = file.path;
                this.saveSettings();
            })
        );

        // Deferred until the workspace is ready: during onload() — on mobile
        // in particular — the vault's file list and metadata cache are often
        // still being populated, so looking the note up then reports it
        // "not found" even though it exists.
        this.app.workspace.onLayoutReady(() => {
            if (this.settings.symbolSource === "note") {
                // Not awaited: every syncFromNote() error path Notices and
                // returns rather than throwing.
                this.startupSync();
            }
        });

        this.addCommand({
            id: "open-symbol-atlas-picker",
            name: "Open Symbol Atlas picker",
            icon: "smile-plus",
            editorCallback: (editor: Editor) => {
                new SymbolPickerModal(this.app, this, editor).open();
            },
            hotkeys: [
                {
                    modifiers: ["Mod", "Shift"],
                    key: "e",
                },
            ],
        });

        this.addCommand({
            id: "open-symbol-atlas-sidebar",
            name: "Open Symbol Atlas sidebar",
            icon: "map",
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: "sync-symbol-atlas-from-note",
            name: "Sync symbols from source note",
            icon: "refresh-cw",
            checkCallback: (checking) => {
                if (this.settings.symbolSource !== "note") return false;
                if (!checking) this.syncFromNote();
                return true;
            },
        });

        this.addRibbonIcon("map", "Open Symbol Atlas", () => this.activateView());

        this.addSettingTab(new SymbolAtlasSettingTab(this.app, this));
    }

    onunload() {
        if (this.syncDebounceTimer !== null) {
            window.clearTimeout(this.syncDebounceTimer);
        }
    }

    async loadSettings() {
        const loaded = await this.loadData();
        const merged: SymbolAtlasSettings = Object.assign({}, DEFAULT_SETTINGS, loaded);
        // Clone so we never hold a live reference into the shared
        // DEFAULT_SYMBOLS module-level objects.
        merged.symbols = (Array.isArray(merged.symbols) ? merged.symbols : DEFAULT_SYMBOLS).map(
            (s) => ({ ...s })
        );
        this.settings = merged;

        // Backfill ids for any entry saved before this field existed
        // (v1.1 and earlier). Idempotent: an entry that already has an id
        // is never touched again, so this is safe to run on every load.
        let didMigrate = false;
        for (const entry of this.settings.symbols) {
            if (!entry.id || typeof entry.id !== "string") {
                entry.id = generateId();
                didMigrate = true;
            }
        }
        if (didMigrate) {
            try {
                await this.saveSettings();
            } catch (e) {
                // Non-fatal: ids still exist in memory for this session,
                // and the migration simply retries on next load. Must not
                // throw here — onload() awaits loadSettings() before it
                // registers the command and settings tab.
                console.error("Symbol Atlas: failed to persist id migration", e);
            }
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshViews();
    }

    refreshViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SYMBOL_ATLAS)) {
            if (leaf.view instanceof SymbolAtlasView) leaf.view.refresh();
        }
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_SYMBOL_ATLAS)[0];
        if (!leaf) {
            const right = workspace.getRightLeaf(false);
            if (!right) return;
            await right.setViewState({ type: VIEW_TYPE_SYMBOL_ATLAS, active: true });
            leaf = right;
        }
        await workspace.revealLeaf(leaf);
    }

    // Looks up the configured source note, tolerating paths that don't match
    // the vault byte-for-byte (see resolveNotePath). When a looser match is
    // found, the stored path is corrected so later lookups and the "changed"
    // listener hit it directly.
    resolveSourceFile(): TFile | null {
        const stored = this.settings.noteSourcePath;
        if (!stored) return null;
        const direct = this.app.vault.getFileByPath(normalizePath(stored));
        if (direct) return direct;

        const resolved = resolveNotePath(
            stored,
            this.app.vault.getMarkdownFiles().map((f) => f.path)
        );
        const file = resolved ? this.app.vault.getFileByPath(resolved) : null;
        if (file && file.path !== stored) {
            this.settings.noteSourcePath = file.path;
            this.saveSettings();
        }
        return file;
    }

    // Startup variant of syncFromNote(): if the note (or its metadata) isn't
    // indexed yet, waits for the vault to catch up instead of immediately
    // reporting it missing.
    private async startupSync() {
        const ready = () => {
            const file = this.resolveSourceFile();
            return !!file && !!this.app.metadataCache.getFileCache(file);
        };
        if (!ready()) {
            await this.waitFor(ready, STARTUP_SYNC_TIMEOUT_MS);
        }
        await this.syncFromNote({ silent: true });
    }

    // Resolves once check() passes (re-tested on every vault/metadata event)
    // or after timeoutMs, whichever comes first.
    private waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            const refs: EventRef[] = [];
            let timer = 0;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                window.clearTimeout(timer);
                for (const ref of refs) this.app.metadataCache.offref(ref);
                resolve();
            };
            const test = () => {
                if (check()) finish();
            };
            refs.push(this.app.metadataCache.on("changed", test));
            refs.push(this.app.metadataCache.on("resolved", test));
            timer = window.setTimeout(finish, timeoutMs);
            // Also release the wait if the plugin is unloaded meanwhile.
            this.register(finish);
        });
    }

    // Re-parses the configured note+heading and merges the result into
    // settings.symbols. Every failure path Notices and returns WITHOUT
    // touching settings.symbols — a typo'd path/heading, or a heading that
    // temporarily has no matching list items, must never silently wipe the
    // user's list. Never calls the settings tab's render() itself: a
    // background sync firing mid-keystroke in its note-picker field would
    // otherwise blow away that input. A sync requested while one is already
    // running is queued and runs right after, so the last edit always wins.
    async syncFromNote(options?: { silent?: boolean }): Promise<void> {
        if (this.syncInFlight) {
            this.syncQueued = true;
            return;
        }
        this.syncInFlight = true;
        try {
            await this.doSyncFromNote(options?.silent ?? false);
        } finally {
            this.syncInFlight = false;
        }
        if (this.syncQueued) {
            this.syncQueued = false;
            await this.syncFromNote({ silent: true });
        }
    }

    private async doSyncFromNote(silent: boolean): Promise<void> {
        const { symbolSource, noteSourcePath, noteSourceHeading } = this.settings;
        if (symbolSource !== "note" || !noteSourcePath || !noteSourceHeading) {
            return;
        }

        const file = this.resolveSourceFile();
        if (!file) {
            new Notice(`Symbol Atlas: source note not found: "${noteSourcePath}"`);
            return;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) {
            // Not indexed yet; the "changed" listener re-syncs once it is.
            if (!silent) {
                new Notice(`Symbol Atlas: "${file.path}" is still being indexed. Try again in a moment.`);
            }
            return;
        }

        const content = await this.app.vault.cachedRead(file);
        const lines = extractSection(content, cache.headings ?? [], noteSourceHeading);
        if (lines === null) {
            new Notice(
                `Symbol Atlas: heading "${noteSourceHeading}" not found in "${file.path}"`
            );
            return;
        }

        const parsed = parseSymbolsFromLines(lines);
        if (parsed.length === 0) {
            new Notice(
                `Symbol Atlas: no "emoji:: descriptor" list items found under "${noteSourceHeading}". Existing symbols were not changed.`
            );
            return;
        }

        this.settings.symbols = mergeParsedSymbols(parsed, this.settings.symbols);
        this.settings.noteSourceLastSynced = Date.now();
        await this.saveSettings();
        if (!silent) {
            new Notice(`Symbol Atlas: synced ${parsed.length} symbols from "${file.path}".`);
        }
    }

    getSortedSymbols(): SymbolEntry[] {
        const symbols = [...this.settings.symbols];
        if (this.settings.sortMode === "alpha") {
            symbols.sort((a, b) => a.name.localeCompare(b.name));
        } else {
            symbols.sort((a, b) => {
                const aTime = a.lastUsed ?? 0;
                const bTime = b.lastUsed ?? 0;
                if (aTime === bTime) return a.name.localeCompare(b.name);
                return bTime - aTime;
            });
        }
        return symbols;
    }

    async markUsed(entry: SymbolEntry) {
        const target = this.settings.symbols.find((s) => s.id === entry.id);
        if (target) {
            target.lastUsed = Date.now();
            target.useCount = (target.useCount ?? 0) + 1;
            await this.saveSettings();
        }
    }

    async insertSymbol(editor: Editor, entry: SymbolEntry) {
        editor.replaceSelection(entry.emoji + this.settings.symbolSuffix);
        await this.markUsed(entry);
    }

    // Inserts into the note the user was last editing — used from the
    // sidebar, where focus has moved off the editor. Falls back to the
    // clipboard when no note is open. Returns whether it inserted.
    async insertIntoLastEditor(entry: SymbolEntry): Promise<boolean> {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.getMode() === "source") {
            this.app.workspace.setActiveLeaf(leaf!, { focus: true });
            await this.insertSymbol(view.editor, entry);
            view.editor.focus();
            return true;
        }
        await this.copySymbol(entry, "No note in editing mode — copied");
        return false;
    }

    async copySymbol(entry: SymbolEntry, prefix = "Copied") {
        try {
            await navigator.clipboard.writeText(entry.emoji + this.settings.symbolSuffix);
            new Notice(`${prefix} ${entry.emoji} to clipboard.`);
        } catch {
            new Notice("Symbol Atlas: couldn't access the clipboard.");
        }
    }

    // Counts each symbol's occurrences across every note in the vault (except
    // the source note, which lists them all by definition). When a suffix
    // like "::" is configured, "<emoji><suffix>" is counted, which matches
    // how symbols are actually logged and avoids counting 🧠 inside 🧠📺.
    async scanVault() {
        if (this.vaultScanInProgress) return;
        this.vaultScanInProgress = true;
        this.refreshViews();
        try {
            const symbols = [...this.settings.symbols];
            const suffix = this.settings.symbolSuffix.trim();
            const needles = symbols.map((s) => s.emoji + suffix);
            const totals = symbols.map(() => ({ total: 0, notes: 0 }));
            const files = this.app.vault
                .getMarkdownFiles()
                .filter((f) => !samePath(f.path, this.settings.noteSourcePath));

            for (let i = 0; i < files.length; i++) {
                const text = await this.app.vault.cachedRead(files[i]);
                countOccurrences(text, needles).forEach((n, j) => {
                    if (n > 0) {
                        totals[j].total += n;
                        totals[j].notes++;
                    }
                });
                // Yield now and then so a large vault doesn't freeze the UI.
                if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
            }

            const counts = new Map<string, OccurrenceCounts>();
            symbols.forEach((s, j) => counts.set(s.id, totals[j]));
            this.vaultScan = { scannedAt: Date.now(), noteCount: files.length, counts };
        } catch (e) {
            console.error("Symbol Atlas: vault scan failed", e);
            new Notice("Symbol Atlas: vault scan failed. See the console for details.");
        } finally {
            this.vaultScanInProgress = false;
            this.refreshViews();
        }
    }
}

class SymbolPickerModal extends FuzzySuggestModal<SymbolEntry> {
    plugin: SymbolAtlasPlugin;
    editor: Editor;

    constructor(app: App, plugin: SymbolAtlasPlugin, editor: Editor) {
        super(app);
        this.plugin = plugin;
        this.editor = editor;
        this.setPlaceholder("Search by descriptor or emoji name...");
        this.setInstructions([
            { command: "↑↓", purpose: "navigate" },
            { command: "↵", purpose: "insert" },
            { command: "esc", purpose: "dismiss" },
        ]);
    }

    getItems(): SymbolEntry[] {
        return this.plugin.getSortedSymbols();
    }

    // This is what FuzzySuggestModal actually searches against. Combining
    // the descriptor with the subtitle and the emoji's real Unicode name
    // (e.g. "brain", "television") lets users find a symbol by any of them.
    getItemText(item: SymbolEntry): string {
        return [item.name, item.subtitle, getEmojiNames(item.emoji)]
            .filter((part) => !!part)
            .join(" ");
    }

    renderSuggestion(match: FuzzyMatch<SymbolEntry>, el: HTMLElement) {
        const item = match.item;
        el.addClass("symbol-atlas-suggestion-item");
        const emojiSpan = el.createSpan({ cls: "symbol-atlas-emoji" });
        emojiSpan.setText(item.emoji);
        const textEl = el.createDiv({ cls: "symbol-atlas-text" });
        textEl.createDiv({ cls: "symbol-atlas-name", text: item.name });
        if (item.subtitle) {
            textEl.createDiv({ cls: "symbol-atlas-subtitle", text: item.subtitle });
        }
    }

    async onChooseItem(item: SymbolEntry) {
        await this.plugin.insertSymbol(this.editor, item);
        new Notice(`Inserted ${item.emoji} (${item.name})`);
    }
}

interface ConfirmModalOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    onConfirm: () => void | Promise<void>;
}

// Generic Cancel/Confirm modal used by every destructive action in this
// plugin (delete, import-replace). Native window.confirm() is avoided
// because it's unreliable in mobile WebViews, and this plugin isn't
// desktop-only.
class ConfirmModal extends Modal {
    options: ConfirmModalOptions;

    constructor(app: App, options: ConfirmModalOptions) {
        super(app);
        this.options = options;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        if (this.options.title) {
            contentEl.createEl("h2", { text: this.options.title });
        }
        contentEl.createEl("p", { text: this.options.message });

        const buttonRow = new Setting(contentEl);
        buttonRow.addButton((button) =>
            button
                .setButtonText(this.options.cancelText ?? "Cancel")
                .onClick(() => this.close())
        );
        buttonRow.addButton((button) => {
            button
                .setButtonText(this.options.confirmText ?? "Confirm")
                .onClick(async () => {
                    this.close();
                    await this.options.onConfirm();
                });
            if (this.options.isDestructive) {
                button.setWarning();
            } else {
                button.setCta();
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

interface SymbolEditResult {
    emoji: string;
    name: string;
    subtitle: string;
}

// Replaces the old window.prompt()-based edit flow: a real Modal works
// reliably on mobile, and lets you fix a mistyped emoji, not just the
// descriptor.
class SymbolEditModal extends Modal {
    onSubmit: (result: SymbolEditResult) => void;
    value: SymbolEditResult;

    constructor(app: App, entry: SymbolEntry, onSubmit: (result: SymbolEditResult) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.value = { emoji: entry.emoji, name: entry.name, subtitle: entry.subtitle ?? "" };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Edit symbol" });

        new Setting(contentEl).setName("Emoji").addText((text) =>
            text.setValue(this.value.emoji).onChange((value) => {
                this.value.emoji = value.trim();
            })
        );

        new Setting(contentEl).setName("Descriptor").addText((text) =>
            text.setValue(this.value.name).onChange((value) => {
                this.value.name = value.trim();
            })
        );

        new Setting(contentEl)
            .setName("Subtitle")
            .setDesc("Optional extra context shown under the descriptor.")
            .addText((text) =>
                text.setValue(this.value.subtitle).onChange((value) => {
                    this.value.subtitle = value.trim();
                })
            );

        const buttonRow = new Setting(contentEl);
        buttonRow.addButton((button) =>
            button.setButtonText("Cancel").onClick(() => this.close())
        );
        buttonRow.addButton((button) =>
            button
                .setButtonText("Save")
                .setCta()
                .onClick(() => {
                    if (!this.value.emoji || !this.value.name) {
                        new Notice(
                            "Please provide both an emoji and a descriptor."
                        );
                        return;
                    }
                    this.onSubmit({ ...this.value });
                    this.close();
                })
        );
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Type-ahead note picker for the "Source note" settings field. Neither
// setValue() nor close() happen automatically on selection, so both are
// called explicitly here rather than relying on the base class's own
// selectSuggestion default (undocumented for a non-string generic type).
class NoteSuggest extends AbstractInputSuggest<TFile> {
    onPick: (file: TFile) => void;

    constructor(app: App, inputEl: HTMLInputElement, onPick: (file: TFile) => void) {
        super(app, inputEl);
        this.onPick = onPick;
        this.limit = 20;
    }

    protected getSuggestions(query: string): TFile[] {
        const q = query.toLowerCase();
        return this.app.vault
            .getMarkdownFiles()
            .filter((f) => f.path.toLowerCase().includes(q))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.setText(file.path);
    }

    selectSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.setValue(file.path);
        this.close();
        this.onPick(file);
    }
}

class SymbolAtlasSettingTab extends PluginSettingTab {
    plugin: SymbolAtlasPlugin;

    constructor(app: App, plugin: SymbolAtlasPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.render();
    }

    hide(): void {}

    render(): void {
        this.containerEl.empty();
        const containerEl = this.containerEl;

        containerEl.createEl("h2", { text: "Symbol Atlas settings" });

        new Setting(containerEl)
            .setName("Default sort mode")
            .setDesc("How the picker orders symbols when it opens.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("recent", "Recently used")
                    .addOption("alpha", "Alphabetical (by name)")
                    .setValue(this.plugin.settings.sortMode)
                    .onChange(async (value) => {
                        this.plugin.settings.sortMode = value as SortMode;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Text to insert after each symbol")
            .setDesc(
                'Automatically added right after the emoji when you pick it, e.g. "::". Leave blank to insert just the symbol.'
            )
            .addText((text) =>
                text
                    .setPlaceholder("::")
                    .setValue(this.plugin.settings.symbolSuffix)
                    .onChange(async (value) => {
                        this.plugin.settings.symbolSuffix = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Show descriptions in sidebar")
            .setDesc(
                "Show each symbol's subtitle under its name in the Symbol Atlas sidebar. Also toggled by the eye button there."
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.sidebarShowSubtitles).onChange(async (value) => {
                    this.plugin.settings.sidebarShowSubtitles = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("Symbol source")
            .setDesc("Manage symbols directly, or mirror them from a list in a note.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("manual", "Manual list")
                    .addOption("note", "Vault note")
                    .setValue(this.plugin.settings.symbolSource)
                    .onChange(async (value) => {
                        const next = value as SymbolSource;
                        const switchingToNote =
                            next === "note" && this.plugin.settings.symbolSource !== "note";
                        const readyToSync =
                            !!this.plugin.settings.noteSourcePath &&
                            !!this.plugin.settings.noteSourceHeading;
                        const wouldReplace = this.plugin.settings.symbols.length > 0;

                        const applyModeChange = async () => {
                            this.plugin.settings.symbolSource = next;
                            await this.plugin.saveSettings();
                            if (switchingToNote && readyToSync) {
                                await this.plugin.syncFromNote();
                            }
                            this.render();
                        };

                        if (switchingToNote && readyToSync && wouldReplace) {
                            new ConfirmModal(this.app, {
                                title: "Switch to note source",
                                message: `This will replace your existing ${this.plugin.settings.symbols.length} symbol(s) with symbols parsed from the configured note. This cannot be undone.`,
                                confirmText: "Switch",
                                isDestructive: true,
                                onConfirm: applyModeChange,
                            }).open();
                        } else {
                            await applyModeChange();
                        }
                    })
            );

        if (this.plugin.settings.symbolSource === "manual") {
            containerEl.createEl("h3", { text: "Add a new symbol" });

            let newEmoji = "";
            let newName = "";
            let newSubtitle = "";

            const addSetting = new Setting(containerEl)
                .setName("New symbol")
                .setDesc(
                    "Enter an emoji and a descriptive name (plus an optional subtitle), then click Add."
                );

            addSetting.addText((text) =>
                text
                    .setPlaceholder("Emoji (e.g. 🎯)")
                    .onChange((value) => {
                        newEmoji = value.trim();
                    })
            );

            addSetting.addText((text) =>
                text
                    .setPlaceholder("Descriptor (e.g. goal / target)")
                    .onChange((value) => {
                        newName = value.trim();
                    })
            );

            addSetting.addText((text) =>
                text.setPlaceholder("Subtitle (optional)").onChange((value) => {
                    newSubtitle = value.trim();
                })
            );

            addSetting.addButton((button) =>
                button
                    .setButtonText("Add")
                    .setCta()
                    .onClick(async () => {
                        if (!newEmoji || !newName) {
                            new Notice("Please provide both an emoji and a descriptor.");
                            return;
                        }
                        const entry: SymbolEntry = {
                            id: generateId(),
                            emoji: newEmoji,
                            name: newName,
                        };
                        if (newSubtitle) entry.subtitle = newSubtitle;
                        this.plugin.settings.symbols.push(entry);
                        await this.plugin.saveSettings();
                        new Notice(`Added ${newEmoji} (${newName})`);
                        this.render();
                    })
            );
        } else {
            containerEl.createEl("h3", { text: "Note source" });

            new Setting(containerEl)
                .setName("Source note")
                .setDesc("Start typing to search your vault for a note.")
                .addText((text) => {
                    text.setPlaceholder("e.g. 05 - Journal/Symbol Atlas.md");
                    text.setValue(this.plugin.settings.noteSourcePath);
                    new NoteSuggest(this.app, text.inputEl, async (file) => {
                        text.setValue(file.path);
                        this.plugin.settings.noteSourcePath = file.path;
                        this.plugin.settings.noteSourceHeading = "";
                        await this.plugin.saveSettings();
                        this.render();
                    });
                });

            const currentFile = this.plugin.resolveSourceFile();
            const headings = currentFile
                ? (this.app.metadataCache.getFileCache(currentFile)?.headings ?? []).filter(
                      (h) => h.level === 2
                  )
                : [];
            const configuredHeading = this.plugin.settings.noteSourceHeading;
            const matchedHeading = headings.find((h) =>
                headingMatches(h.heading, configuredHeading)
            );
            const headingMissing = !!configuredHeading && !matchedHeading;

            new Setting(containerEl)
                .setName("Heading")
                .setDesc(
                    !this.plugin.settings.noteSourcePath
                        ? "Choose a source note first."
                        : !currentFile
                        ? `Note not found: "${this.plugin.settings.noteSourcePath}". Re-select it above.`
                        : headingMissing
                        ? `Heading "${configuredHeading}" not found in this note (renamed?). Pick a heading below.`
                        : headings.length === 0
                        ? "This note has no level-2 (##) headings."
                        : "Symbols are parsed from the list items under this heading."
                )
                .addDropdown((dropdown) => {
                    dropdown.addOption("", "— Select a heading —");
                    if (headingMissing) {
                        dropdown.addOption(configuredHeading, `${configuredHeading} (not found)`);
                    }
                    for (const h of headings) {
                        dropdown.addOption(h.heading, h.heading);
                    }
                    dropdown.setValue(matchedHeading?.heading ?? configuredHeading);
                    dropdown.setDisabled(!currentFile || headings.length === 0);
                    dropdown.onChange(async (value) => {
                        const wouldReplace = this.plugin.settings.symbols.length > 0;
                        const applyHeadingChange = async () => {
                            this.plugin.settings.noteSourceHeading = value;
                            await this.plugin.saveSettings();
                            if (value) await this.plugin.syncFromNote();
                            this.render();
                        };
                        if (value && wouldReplace) {
                            new ConfirmModal(this.app, {
                                title: "Change source heading",
                                message: `This will replace your existing ${this.plugin.settings.symbols.length} symbol(s) with symbols parsed from "${value}". This cannot be undone.`,
                                confirmText: "Switch",
                                isDestructive: true,
                                onConfirm: applyHeadingChange,
                            }).open();
                        } else {
                            await applyHeadingChange();
                        }
                    });
                });

            new Setting(containerEl)
                .setName("Sync now")
                .setDesc(
                    this.plugin.settings.noteSourceLastSynced
                        ? `${this.plugin.settings.symbols.length} symbols · last synced ${new Date(
                              this.plugin.settings.noteSourceLastSynced
                          ).toLocaleString()}`
                        : "Not yet synced."
                )
                .addButton((button) =>
                    button
                        .setButtonText("Sync now")
                        .setCta()
                        .onClick(async () => {
                            await this.plugin.syncFromNote();
                            this.render();
                        })
                );
        }

        containerEl.createEl("h3", { text: "Existing symbols" });

        const sorted = this.plugin.getSortedSymbols();

        sorted.forEach((entry) => {
            const lastUsed = entry.lastUsed
                ? `Last used: ${new Date(entry.lastUsed).toLocaleString()}`
                : "Never used";
            const usage = entry.useCount ? `Used ${entry.useCount}× · ${lastUsed}` : lastUsed;
            const row = new Setting(containerEl)
                .setName(`${entry.emoji}  ${entry.name}`)
                .setDesc(entry.subtitle ? `${entry.subtitle} — ${usage}` : usage);

            if (this.plugin.settings.symbolSource === "manual") {
                row.addButton((button) =>
                    button
                        .setIcon("pencil")
                        .setTooltip("Edit")
                        .onClick(() => {
                            new SymbolEditModal(this.app, entry, async (result) => {
                                const target = this.plugin.settings.symbols.find(
                                    (s) => s.id === entry.id
                                );
                                if (target) {
                                    target.emoji = result.emoji;
                                    target.name = result.name;
                                    if (result.subtitle) target.subtitle = result.subtitle;
                                    else delete target.subtitle;
                                    await this.plugin.saveSettings();
                                    this.render();
                                }
                            }).open();
                        })
                );

                row.addButton((button) =>
                    button
                        .setIcon("trash")
                        .setTooltip("Delete")
                        .onClick(() => {
                            new ConfirmModal(this.app, {
                                title: "Delete symbol",
                                message: `Delete ${entry.emoji} "${entry.name}"? This cannot be undone.`,
                                confirmText: "Delete",
                                isDestructive: true,
                                onConfirm: async () => {
                                    this.plugin.settings.symbols =
                                        this.plugin.settings.symbols.filter(
                                            (s) => s.id !== entry.id
                                        );
                                    await this.plugin.saveSettings();
                                    this.render();
                                },
                            }).open();
                        })
                );
            }
        });

        containerEl.createEl("h3", { text: "Import / export" });

        new Setting(containerEl)
            .setName("Export Symbol Atlas as JSON")
            .setDesc("Copies your full symbol list to the clipboard.")
            .addButton((button) =>
                button.setButtonText("Copy JSON").onClick(async () => {
                    try {
                        await navigator.clipboard.writeText(
                            JSON.stringify(this.plugin.settings.symbols, null, 2)
                        );
                        new Notice("Symbol Atlas copied to clipboard.");
                    } catch {
                        new Notice("Symbol Atlas: couldn't access the clipboard.");
                    }
                })
            );

        if (this.plugin.settings.symbolSource === "manual") {
            let importText = "";
            new Setting(containerEl)
                .setName("Import Symbol Atlas JSON")
                .setDesc(
                    "Paste a JSON array of {emoji, name} objects, then click Import. " +
                        "You'll be asked to confirm before it replaces your current list."
                )
                .addTextArea((text) => {
                    text.setPlaceholder('[{"emoji":"🎯","name":"goal"}]');
                    text.onChange((value) => {
                        importText = value;
                    });
                })
                .addButton((button) =>
                    button
                        .setButtonText("Import")
                        .setWarning()
                        .onClick(() => {
                            let imported: SymbolEntry[];
                            try {
                                imported = parseImportedSymbols(importText);
                            } catch (e) {
                                new Notice(
                                    e instanceof Error
                                        ? e.message
                                        : "Invalid JSON. Import failed."
                                );
                                return;
                            }

                            const currentCount = this.plugin.settings.symbols.length;
                            const importedCount = imported.length;
                            new ConfirmModal(this.app, {
                                title: "Import Symbol Atlas",
                                message:
                                    `This will replace your existing ${currentCount} symbol${currentCount === 1 ? "" : "s"} ` +
                                    `with ${importedCount} imported symbol${importedCount === 1 ? "" : "s"}. This cannot be undone.`,
                                confirmText: "Import",
                                isDestructive: true,
                                onConfirm: async () => {
                                    this.plugin.settings.symbols = imported;
                                    await this.plugin.saveSettings();
                                    new Notice("Symbol Atlas imported successfully.");
                                    this.render();
                                },
                            }).open();
                        })
                );
        } else {
            new Setting(containerEl).setDesc(
                'Symbols are managed from the configured note above. Switch to "Manual list" to add, edit, delete, or import symbols directly.'
            );
        }
    }
}
