import {
    App,
    Editor,
    FuzzyMatch,
    FuzzySuggestModal,
    Plugin,
    PluginSettingTab,
    Setting,
    Notice,
} from "obsidian";
import { emojiToName } from "gemoji";

interface SymbolEntry {
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
    { emoji: "✅", name: "done / completed" },
    { emoji: "🚧", name: "in progress / work in progress" },
    { emoji: "❗", name: "important / warning" },
    { emoji: "💡", name: "idea" },
    { emoji: "🔗", name: "link / reference" },
    { emoji: "📌", name: "pinned / priority" },
    { emoji: "🐛", name: "bug" },
    { emoji: "🔥", name: "urgent / hot" },
    { emoji: "📚", name: "reading / book" },
    { emoji: "🎮", name: "game / gaming" },
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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
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
        const target = this.settings.symbols.find(
            (s) => s.emoji === entry.emoji && s.name === entry.name
        );
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
                    .onClick(async () => {
                        const newDesc = window.prompt(
                            "Edit descriptor:",
                            entry.name
                        );
                        if (newDesc && newDesc.trim().length > 0) {
                            entry.name = newDesc.trim();
                            await this.plugin.saveSettings();
                            this.render();
                        }
                    })
            );

            row.addButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip("Delete")
                    .onClick(async () => {
                        this.plugin.settings.symbols =
                            this.plugin.settings.symbols.filter(
                                (s) => s !== entry
                            );
                        await this.plugin.saveSettings();
                        this.render();
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
            .setDesc("Paste a JSON array of {emoji, name} objects, then click Import (this replaces your current list).")
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
                    .onClick(async () => {
                        try {
                            const parsed = JSON.parse(importText);
                            if (!Array.isArray(parsed)) throw new Error();
                            this.plugin.settings.symbols = parsed;
                            await this.plugin.saveSettings();
                            new Notice("Symbol Atlas imported successfully.");
                            this.render();
                        } catch (e) {
                            new Notice("Invalid JSON. Import failed.");
                        }
                    })
            );
    }
}
