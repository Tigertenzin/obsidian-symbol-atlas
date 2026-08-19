import {
    App,
    Editor,
    FuzzyMatch,
    FuzzySuggestModal,
    Modal,
    Plugin,
    PluginSettingTab,
    Setting,
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

interface SymbolAtlasSettings {
    symbols: SymbolEntry[];
    sortMode: SortMode;
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

export default class SymbolAtlasPlugin extends Plugin {
    settings: SymbolAtlasSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: "open-symbol-atlas-picker",
            name: "Open Symbol Atlas picker",
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
        this.editor.replaceSelection(item.emoji);
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
    }
}
