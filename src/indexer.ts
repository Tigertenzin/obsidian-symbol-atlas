import { TFile } from "obsidian";
import type SymbolAtlasPlugin from "../main";
import { IndexedNote, TokenHit, extractTokens } from "./stats";

const CACHE_VERSION = 1;
const CACHE_FILE = "symbol-index.json";

interface CachedNote {
    mtime: number;
    size: number;
    hits: TokenHit[];
}

interface CacheFile {
    version: number;
    suffix: string;
    notes: Record<string, CachedNote>;
}

// Keeps a per-note list of logged symbols for the whole vault, so stats
// never need to re-read every note. Notes are re-read only when their
// mtime/size changed since the cached copy (saved in the plugin folder),
// and edits made while Obsidian is open are picked up from the metadata
// cache's "changed" event, which hands over the new content directly.
export class SymbolIndex {
    private notes = new Map<string, CachedNote>();
    private suffix = "";
    private saveTimer: number | null = null;
    private changeTimer: number | null = null;
    private generation = 0;
    building = false;
    progress = { done: 0, total: 0 };
    ready = false;
    private started = false;
    lastBuilt: number | null = null;

    constructor(private plugin: SymbolAtlasPlugin) {}

    private get cachePath(): string {
        return `${this.plugin.manifest.dir}/${CACHE_FILE}`;
    }

    entries(): IndexedNote[] {
        return [...this.notes].map(([path, n]) => ({ path, hits: n.hits }));
    }

    get indexedSuffix(): string {
        return this.suffix;
    }

    get noteCount(): number {
        return this.notes.size;
    }

    async load() {
        const adapter = this.plugin.app.vault.adapter;
        try {
            if (!(await adapter.exists(this.cachePath))) return;
            const cache = JSON.parse(await adapter.read(this.cachePath)) as CacheFile;
            if (cache.version !== CACHE_VERSION) return;
            this.suffix = cache.suffix;
            this.notes = new Map(Object.entries(cache.notes));
        } catch (e) {
            console.warn("Symbol Atlas: ignoring unreadable index cache", e);
        }
    }

    // Brings the index up to date with the vault. Safe to call repeatedly:
    // a newer call supersedes one still running.
    async build(options?: { force?: boolean }) {
        const gen = ++this.generation;
        this.started = true;
        const { vault } = this.plugin.app;
        const suffix = this.plugin.settings.symbolSuffix.trim();
        if (options?.force || suffix !== this.suffix) {
            this.notes.clear();
            this.suffix = suffix;
        }
        const files = vault.getMarkdownFiles();
        const live = new Set(files.map((f) => f.path));
        for (const path of [...this.notes.keys()]) {
            if (!live.has(path)) this.notes.delete(path);
        }
        const stale = files.filter((f) => {
            const c = this.notes.get(f.path);
            return !c || c.mtime !== f.stat.mtime || c.size !== f.stat.size;
        });

        this.building = true;
        this.progress = { done: 0, total: stale.length };
        this.plugin.onIndexUpdated();
        try {
            for (let i = 0; i < stale.length; i++) {
                if (gen !== this.generation) return;
                const file = stale[i];
                try {
                    this.store(file, await vault.cachedRead(file));
                } catch (e) {
                    console.warn(`Symbol Atlas: couldn't index ${file.path}`, e);
                }
                this.progress.done = i + 1;
                // Yield now and then so a large vault doesn't freeze the UI.
                if (i % 50 === 49) {
                    this.plugin.onIndexUpdated();
                    await new Promise((r) => window.setTimeout(r, 0));
                }
            }
        } finally {
            if (gen === this.generation) {
                this.building = false;
                this.ready = true;
                this.lastBuilt = Date.now();
                this.scheduleSave();
                this.plugin.onIndexUpdated();
            }
        }
    }

    private store(file: TFile, content: string) {
        this.notes.set(file.path, {
            mtime: file.stat.mtime,
            size: file.stat.size,
            hits: extractTokens(content, this.suffix),
        });
    }

    // Called from the metadata cache's "changed" event with the new content.
    // Before the first build starts, edits are caught by its mtime check.
    noteChanged(file: TFile, content: string) {
        if (!this.started || file.extension !== "md") return;
        this.store(file, content);
        this.changed();
    }

    noteDeleted(path: string) {
        if (this.notes.delete(path)) this.changed();
    }

    noteRenamed(oldPath: string, newPath: string) {
        const entry = this.notes.get(oldPath);
        if (!entry) return;
        this.notes.delete(oldPath);
        this.notes.set(newPath, entry);
        this.changed();
    }

    private changed() {
        this.scheduleSave();
        if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
        this.changeTimer = window.setTimeout(() => {
            this.changeTimer = null;
            this.plugin.onIndexUpdated();
        }, 400);
    }

    private scheduleSave() {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, 2000);
    }

    async save() {
        const cache: CacheFile = {
            version: CACHE_VERSION,
            suffix: this.suffix,
            notes: Object.fromEntries(this.notes),
        };
        try {
            await this.plugin.app.vault.adapter.write(this.cachePath, JSON.stringify(cache));
        } catch (e) {
            console.warn("Symbol Atlas: couldn't save index cache", e);
        }
    }

    // Flush a pending save and stop timers (plugin unload).
    async dispose() {
        this.generation++;
        if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
            await this.save();
        }
    }
}
