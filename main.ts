import {
    AbstractInputSuggest,
    App,
    Editor,
    FuzzyMatch,
    FuzzySuggestModal,
    HeadingCache,
    Modal,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    Notice,
} from "obsidian";
import { emojiToName } from "gemoji";

interface SymbolEntry {
    id: string;
    emoji: string;
    name: string;
    lastUsed?: number; // epoch ms, undefined if never used
}

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
}

const DEFAULT_SYMBOLS: SymbolEntry[] = [
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

const DEFAULT_SETTINGS: SymbolAtlasSettings = {
    symbols: DEFAULT_SYMBOLS,
    sortMode: "recent",
    symbolSuffix: "",
    symbolSource: "manual",
    noteSourcePath: "",
    noteSourceHeading: "",
};

// Splits a string into individual emoji "graphemes" (handles multi-emoji
// combos like "🧠📺" by breaking them into "🧠" and "📺" separately) and
// looks up each one's official Unicode name via the gemoji dataset.
function getEmojiNames(emojiStr: string): string {
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

function generateId(): string {
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
    if (typeof obj.lastUsed === "number" && Number.isFinite(obj.lastUsed)) {
        entry.lastUsed = obj.lastUsed;
    }
    return entry;
}

// Parses and validates a full import payload. Rejects the whole batch (no
// partial/silent-skip) if anything is malformed, since a bad paste almost
// always means the whole paste is wrong, not just one entry.
function parseImportedSymbols(text: string): SymbolEntry[] {
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

interface ParsedSymbol {
    emoji: string;
    name: string;
}

// Finds the H2 heading matching headingText and returns the raw lines
// strictly between it and the next heading of level <= 2 (or EOF). Always
// slices the raw, unmodified file content (frontmatter included) — Heading
// positions are 0-based line indexes into that exact string, so stripping
// anything beforehand would throw off every line number.
function extractSection(
    content: string,
    headings: HeadingCache[],
    headingText: string
): string[] | null {
    const target = headings.find(
        (h) => h.level === 2 && h.heading.trim() === headingText.trim()
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

    const lines = content.split("\n");
    const startLine = target.position.start.line + 1;
    const endLine = boundaryLine === null ? lines.length : boundaryLine;
    return lines.slice(startLine, endLine);
}

// Matches list-item lines at any nesting depth and splits each on the
// first "::" into {emoji, name}. Lines without "::" (organizational notes,
// prose) are silently skipped — this has no parent/child awareness, so a
// non-matching bullet never suppresses its own matching children.
function parseSymbolsFromLines(lines: string[]): ParsedSymbol[] {
    const out: ParsedSymbol[] = [];
    const listItemRe = /^\s*[-*+]\s+(.*)$/;
    for (const line of lines) {
        const match = listItemRe.exec(line);
        if (!match) continue;
        const text = match[1];
        const sep = text.indexOf("::");
        if (sep === -1) continue;
        const emoji = text.slice(0, sep).trim();
        const name = text.slice(sep + 2).trim();
        if (!emoji || !name) continue;
        out.push({ emoji, name });
    }
    return out;
}

// Reconciles a freshly-parsed symbol list against the previous one so a
// re-sync never resets usage history: entries are matched to existing ones
// by emoji (a FIFO queue per emoji handles duplicates without special
// casing), preserving id/lastUsed on a match. Existing entries whose emoji
// no longer appears are dropped — the note is the source of truth once in
// note mode, so a removed line should disappear from the picker too.
function mergeParsedSymbols(
    parsed: ParsedSymbol[],
    existing: SymbolEntry[]
): SymbolEntry[] {
    const pool = new Map<string, SymbolEntry[]>();
    for (const e of existing) {
        if (!pool.has(e.emoji)) pool.set(e.emoji, []);
        pool.get(e.emoji)!.push(e);
    }
    return parsed.map(({ emoji, name }) => {
        const match = pool.get(emoji)?.shift();
        return match
            ? { id: match.id, emoji, name, lastUsed: match.lastUsed }
            : { id: generateId(), emoji, name };
    });
}

export default class SymbolAtlasPlugin extends Plugin {
    settings: SymbolAtlasSettings;
    private syncDebounceTimer: number | null = null;
    private syncInFlight = false;

    async onload() {
        await this.loadSettings();

        // Fires only once the note's cache is actually up to date (unlike
        // vault "modify", which fires before the async re-index finishes).
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                if (this.settings.symbolSource !== "note") return;
                if (file.path !== this.settings.noteSourcePath) return;
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
                if (this.settings.noteSourcePath !== oldPath) return;
                this.settings.noteSourcePath = file.path;
                this.saveSettings();
            })
        );

        if (this.settings.symbolSource === "note") {
            // Not awaited: I/O shouldn't block command/settings-tab
            // registration, and every syncFromNote() error path Notices
            // and returns rather than throwing.
            this.syncFromNote({ silent: true });
        }

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

        this.addSettingTab(new SymbolAtlasSettingTab(this.app, this));
    }

    onunload() {}

    async loadSettings() {
        const loaded = await this.loadData();
        const merged: SymbolAtlasSettings = Object.assign({}, DEFAULT_SETTINGS, loaded);
        // Clone so we never hold a live reference into the shared
        // DEFAULT_SYMBOLS module-level objects.
        merged.symbols = (merged.symbols ?? DEFAULT_SYMBOLS).map((s) => ({ ...s }));
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
    }

    // Re-parses the configured note+heading and merges the result into
    // settings.symbols. Every failure path Notices and returns WITHOUT
    // touching settings.symbols — a typo'd path/heading, or a heading that
    // temporarily has no matching list items, must never silently wipe the
    // user's list. Never calls render() itself: a background sync firing
    // mid-keystroke in the settings tab's note-picker field would otherwise
    // blow away that input (render() empties and rebuilds the whole tab).
    async syncFromNote(options?: { silent?: boolean }): Promise<void> {
        if (this.syncInFlight) return;
        this.syncInFlight = true;
        try {
            const silent = options?.silent ?? false;
            const { symbolSource, noteSourcePath, noteSourceHeading } = this.settings;
            if (symbolSource !== "note" || !noteSourcePath || !noteSourceHeading) {
                return;
            }

            const file = this.app.vault.getFileByPath(noteSourcePath);
            if (!file) {
                new Notice(`Symbol Atlas: source note not found: "${noteSourcePath}"`);
                return;
            }

            const content = await this.app.vault.cachedRead(file);
            const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
            const lines = extractSection(content, headings, noteSourceHeading);
            if (lines === null) {
                new Notice(
                    `Symbol Atlas: heading "${noteSourceHeading}" not found in "${noteSourcePath}"`
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
                new Notice(
                    `Symbol Atlas: synced ${parsed.length} symbols from "${noteSourcePath}".`
                );
            }
        } finally {
            this.syncInFlight = false;
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
            await this.saveSettings();
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
    // the descriptor with the emoji's real Unicode name (e.g. "brain",
    // "television") lets users find a symbol by either one.
    getItemText(item: SymbolEntry): string {
        const emojiNames = getEmojiNames(item.emoji);
        return emojiNames ? `${item.name} ${emojiNames}` : item.name;
    }

    renderSuggestion(match: FuzzyMatch<SymbolEntry>, el: HTMLElement) {
        const item = match.item;
        el.addClass("symbol-atlas-suggestion-item");
        const emojiSpan = el.createSpan({ cls: "symbol-atlas-emoji" });
        emojiSpan.setText(item.emoji);
        const nameSpan = el.createSpan({ cls: "symbol-atlas-name" });
        nameSpan.setText(item.name);
    }

    async onChooseItem(item: SymbolEntry) {
        this.editor.replaceSelection(item.emoji + this.plugin.settings.symbolSuffix);
        await this.plugin.markUsed(item);
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

// Replaces the old window.prompt()-based edit flow: a real Modal works
// reliably on mobile, and lets you fix a mistyped emoji, not just the
// descriptor.
class SymbolEditModal extends Modal {
    onSubmit: (result: { emoji: string; name: string }) => void;
    emojiValue: string;
    nameValue: string;

    constructor(
        app: App,
        entry: SymbolEntry,
        onSubmit: (result: { emoji: string; name: string }) => void
    ) {
        super(app);
        this.onSubmit = onSubmit;
        this.emojiValue = entry.emoji;
        this.nameValue = entry.name;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Edit symbol" });

        new Setting(contentEl).setName("Emoji").addText((text) =>
            text.setValue(this.emojiValue).onChange((value) => {
                this.emojiValue = value.trim();
            })
        );

        new Setting(contentEl).setName("Descriptor").addText((text) =>
            text.setValue(this.nameValue).onChange((value) => {
                this.nameValue = value.trim();
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
                    if (!this.emojiValue || !this.nameValue) {
                        new Notice(
                            "Please provide both an emoji and a descriptor."
                        );
                        return;
                    }
                    this.onSubmit({ emoji: this.emojiValue, name: this.nameValue });
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

            const addSetting = new Setting(containerEl)
                .setName("New symbol")
                .setDesc("Enter an emoji and a descriptive name, then click Add.");

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

            addSetting.addButton((button) =>
                button
                    .setButtonText("Add")
                    .setCta()
                    .onClick(async () => {
                        if (!newEmoji || !newName) {
                            new Notice("Please provide both an emoji and a descriptor.");
                            return;
                        }
                        this.plugin.settings.symbols.push({
                            id: generateId(),
                            emoji: newEmoji,
                            name: newName,
                        });
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

            const currentFile = this.plugin.settings.noteSourcePath
                ? this.app.vault.getFileByPath(this.plugin.settings.noteSourcePath)
                : null;
            const headings = currentFile
                ? (this.app.metadataCache.getFileCache(currentFile)?.headings ?? []).filter(
                      (h) => h.level === 2
                  )
                : [];
            const configuredHeading = this.plugin.settings.noteSourceHeading;
            const headingMissing =
                !!configuredHeading && !headings.some((h) => h.heading === configuredHeading);

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
                    dropdown.setValue(configuredHeading);
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
            const row = new Setting(containerEl)
                .setName(`${entry.emoji}  ${entry.name}`)
                .setDesc(
                    entry.lastUsed
                        ? `Last used: ${new Date(entry.lastUsed).toLocaleString()}`
                        : "Never used"
                );

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
                    await navigator.clipboard.writeText(
                        JSON.stringify(this.plugin.settings.symbols, null, 2)
                    );
                    new Notice("Symbol Atlas copied to clipboard.");
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
