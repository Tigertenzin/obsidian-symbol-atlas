import { test } from "node:test";
import assert from "node:assert/strict";
import {
    aggregate,
    coOccurrences,
    compareWindows,
    compileDateFormat,
    coverage,
    dormantSymbols,
    extractTokens,
    heatmapWeeks,
    journalDater,
    streaks,
    weekdayIndex,
    weekdayLean,
    weeklyDays,
} from "../src/stats.ts";

test("compileDateFormat: the user's 'Journal 2026-10-05 Mon' style", () => {
    const parse = compileDateFormat("[Journal] YYYY-MM-DD ddd")!;
    assert.equal(parse("Journal 2026-10-05 Mon"), "2026-10-05");
    assert.equal(parse("journal 2026-10-05 mon"), "2026-10-05");
    assert.equal(parse("Journal 2026-10-05"), null);
    assert.equal(parse("Journal 2026-02-30 Mon"), null);
    assert.equal(parse("Meeting notes"), null);
});

test("compileDateFormat: other common formats", () => {
    assert.equal(compileDateFormat("YYYY-MM-DD")!("2026-01-09"), "2026-01-09");
    assert.equal(compileDateFormat("dddd, MMMM Do YYYY")!("Monday, October 5th 2026"), "2026-10-05");
    assert.equal(compileDateFormat("DD.MM.YY")!("05.10.26"), "2026-10-05");
    assert.equal(compileDateFormat("D MMM YYYY")!("5 Oct 2026"), "2026-10-05");
    assert.equal(compileDateFormat("journal"), null); // no date tokens
    assert.equal(compileDateFormat(""), null);
});

test("journalDater: folder scoping and nested formats", () => {
    const dateOf = journalDater("05 - Journal", "[Journal] YYYY-MM-DD ddd");
    assert.equal(dateOf("05 - Journal/2026/Journal 2026-10-05 Mon.md"), "2026-10-05");
    assert.equal(dateOf("Other/Journal 2026-10-05 Mon.md"), null);
    assert.equal(dateOf("05 - Journal/Symbol Atlas.md"), null);
    const nested = journalDater("Daily", "YYYY/MM/YYYY-MM-DD");
    assert.equal(nested("Daily/2026/10/2026-10-05.md"), "2026-10-05");
    assert.equal(journalDater("", "YYYY-MM-DD")("2026-10-05.md"), "2026-10-05");
});

test("extractTokens: whole symbol before the suffix, entry text, skips word fields", () => {
    const hits = extractTokens(
        "- 🧭:: tired but okay\n- 🧠📺:: a doc\n- mood:: fine\n**⭐️**:: bold\n🎮:: one 🛍️:: two",
        "::"
    );
    assert.deepEqual(
        hits.map((h) => [h.token, h.line, h.text]),
        [
            ["🧭", 0, "tired but okay"],
            ["🧠📺", 1, "a doc"],
            ["⭐", 3, "bold"],
            ["🎮", 4, "one"],
            ["🛍️".replace(/️/g, ""), 4, "two"],
        ]
    );
});

test("extractTokens: no suffix counts emoji runs", () => {
    const hits = extractTokens("Played 🎮 then 🧠📺 later", "");
    assert.deepEqual(hits.map((h) => h.token), ["🎮", "🧠📺"]);
});

const sym = (emoji: string, name = emoji) => ({ id: emoji, emoji, name });

test("aggregate + per-symbol stats", () => {
    const dateOf = journalDater("J", "YYYY-MM-DD");
    const notes = [
        { path: "J/2026-10-01.md", hits: extractTokens("🧭:: meh\n🎮:: game", "::") },
        { path: "J/2026-10-02.md", hits: extractTokens("🧭:: good\n🎮:: again\n🌧️:: rain", "::") },
        { path: "J/2026-10-04.md", hits: extractTokens("🧭:: great", "::") },
        { path: "J/2026-10-05.md", hits: extractTokens("nothing logged", "::") },
        { path: "Notes/idea.md", hits: extractTokens("🎮:: not a journal note", "::") },
    ];
    const symbols = [sym("🧭"), sym("🎮"), sym("📚")];
    const stats = aggregate(notes, symbols, dateOf);
    const mood = stats.bySymbol.get("🧭")!;
    assert.equal(mood.total, 3);
    assert.equal(mood.lastDate, "2026-10-04");
    assert.deepEqual(mood.recent.map((e) => e.text), ["great", "good", "meh"]);
    assert.equal(stats.bySymbol.get("🎮")!.total, 3);
    assert.equal(stats.bySymbol.get("🎮")!.days.size, 2);
    assert.deepEqual(stats.untracked.map((u) => [u.token, u.display, u.total, u.lastDate]), [["🌧", "🌧️", 1, "2026-10-02"]]);

    assert.equal(daysLogged(mood.days), 3);
    assert.deepEqual(streaks(mood.days, "2026-10-05"), { current: 1, longest: 2 });
    assert.deepEqual(streaks(mood.days, "2026-10-04"), { current: 1, longest: 2 });
    assert.deepEqual(weeklyDays(mood.days, "2026-10-05", 2), [0, 3]);

    const cov = coverage(stats, "2026-10-05");
    assert.equal(cov.journalDays, 4);
    assert.equal(cov.daysWithSymbols, 3);
    assert.deepEqual(coOccurrences(stats).map((p) => p.days), [2]);
    assert.deepEqual(
        dormantSymbols(stats, symbols, "2026-10-05", 60).map((d) => d.symbol.emoji),
        ["📚"]
    );
    assert.deepEqual(compareWindows(stats, "2026-11-02", 30).map((c) => [c.key, c.before, c.after]), [
        ["🎮", 2, 0],
        ["🧭", 2, 1],
    ]);
});

function daysLogged(days: Map<string, number>) {
    return days.size;
}

test("weekdays and heatmap layout", () => {
    assert.equal(weekdayIndex("2026-10-05"), 0); // a Monday
    assert.equal(weekdayIndex("2026-10-11"), 6);
    const saturdays = new Map(["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26", "2026-09-29"].map((d) => [d, 1]));
    assert.deepEqual(weekdayLean(saturdays), { weekday: 5, share: 0.8 });
    const grid = heatmapWeeks(new Map([["2026-10-05", 2]]), "2026-10-06", 2);
    assert.equal(grid.length, 2);
    assert.deepEqual(grid[1][0], { date: "2026-10-05", count: 2 });
    assert.equal(grid[1][2], null); // Wednesday is in the future
});
