import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeUsageStats,
    countOccurrences,
    extractSection,
    mergeParsedSymbols,
    parseImportedSymbols,
    parseSymbolsFromLines,
    resolveNotePath,
    samePath,
} from "../src/core.ts";

const heading = (text: string, level: number, line: number) => ({
    heading: text,
    level,
    position: {
        start: { line, col: 0, offset: 0 },
        end: { line, col: 0, offset: 0 },
    },
});

test("resolveNotePath: exact match wins", () => {
    assert.equal(resolveNotePath("a/Atlas.md", ["a/Atlas.md", "b/Atlas.md"]), "a/Atlas.md");
});

test("resolveNotePath: NFD path stored, NFC path in vault", () => {
    const nfc = "Journal/Café Symbols.md";
    assert.equal(resolveNotePath(nfc.normalize("NFD"), [nfc]), nfc);
});

test("resolveNotePath: case, slashes and missing .md", () => {
    assert.equal(resolveNotePath("/journal/symbol atlas/", ["Journal/Symbol Atlas.md"]), "Journal/Symbol Atlas.md");
});

test("resolveNotePath: moved note found by unique file name only", () => {
    assert.equal(resolveNotePath("Old/Atlas.md", ["New/Atlas.md"]), "New/Atlas.md");
    assert.equal(resolveNotePath("Old/Atlas.md", ["A/Atlas.md", "B/Atlas.md"]), null);
    assert.equal(resolveNotePath("", ["Atlas.md"]), null);
});

test("samePath ignores normalization and case only", () => {
    assert.ok(samePath("É.md".normalize("NFD"), "é.md"));
    assert.ok(!samePath("a/x.md", "b/x.md"));
    assert.ok(!samePath("", "x.md"));
});

test("extractSection: NFD heading, CRLF content, stops at next H2", () => {
    const content = "# T\r\n## Symbols é\r\n- 🧭:: mood\r\n## Other\r\n- ⭐:: win\r\n";
    const headings = [heading("T", 1, 0), heading("Symbols é".normalize("NFD"), 2, 1), heading("Other", 2, 3)];
    assert.deepEqual(extractSection(content, headings as any, "Symbols é"), ["- 🧭:: mood"]);
});

test("parseSymbolsFromLines: subtitles, tabs mixed with spaces, tasks and ordered lists", () => {
    const parsed = parseSymbolsFromLines([
        "- 🧭:: how i'm feeling",
        "\t- generally, that day",
        "    - more detail",
        "- [ ] ⭐:: proud of",
        "1. 🎮:: gaming",
        "- plain note",
        "    - 🛍️:: spending",
        "- :: malformed",
        "    - orphan child",
    ]);
    assert.deepEqual(parsed, [
        { emoji: "🧭", name: "how i'm feeling", subtitle: "generally, that day more detail" },
        { emoji: "⭐", name: "proud of" },
        { emoji: "🎮", name: "gaming" },
        { emoji: "🛍️", name: "spending" },
    ]);
});

test("mergeParsedSymbols keeps id, lastUsed and useCount", () => {
    const merged = mergeParsedSymbols(
        [{ emoji: "⭐", name: "new name" }, { emoji: "🎮", name: "game" }],
        [{ id: "x", emoji: "⭐", name: "old", lastUsed: 5, useCount: 3 }]
    );
    assert.deepEqual(merged[0], { id: "x", emoji: "⭐", name: "new name", lastUsed: 5, useCount: 3 });
    assert.equal(merged[1].useCount, undefined);
});

test("parseImportedSymbols round-trips useCount and rejects bad entries", () => {
    const [e] = parseImportedSymbols('[{"id":"a","emoji":"⭐","name":"n","useCount":4}]');
    assert.equal(e.useCount, 4);
    assert.throws(() => parseImportedSymbols('[{"emoji":"⭐"}]'), /name/);
});

test("countOccurrences ignores variation selectors and respects suffix", () => {
    const text = "⭐️:: did a thing\n⭐:: another\n🧠📺:: tv\n🧠:: think";
    assert.deepEqual(countOccurrences(text, ["⭐::", "🧠::", "🧠📺::"]), [2, 1, 1]);
});

test("computeUsageStats", () => {
    const s = computeUsageStats([
        { id: "a", emoji: "a", name: "a", useCount: 2, lastUsed: 10 },
        { id: "b", emoji: "b", name: "b", lastUsed: 20 },
        { id: "c", emoji: "c", name: "c" },
    ]);
    assert.equal(s.totalInsertions, 2);
    assert.equal(s.usedCount, 2);
    assert.equal(s.neverUsedCount, 1);
    assert.deepEqual(s.mostUsed.map((x) => x.id), ["a"]);
    assert.deepEqual(s.recentlyUsed.map((x) => x.id), ["b", "a"]);
});
