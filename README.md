# Symbol Atlas — Obsidian Plugin

A custom emoji-style picker for Obsidian, populated entirely from my "Symbol Atlas": a list of {emoji, descriptor} 

## Motivation

I created this plugin as a way to make adding emoji into my daily journal more convenient. Why? 

I try and journal every day, it’s very helpful for me to reflect and remember my days, how i’m feeling, what i do, etc. I took from [this obsidian set-up on discord] the idea of using emoji to represent certain types of things happening during the day. examples include: 
- 🧭:: how i’m feeling, generally 
- ⭐:: something i accomplished and am proud of 
- 🛍️:: extraneously spending money 
- 🎮:: playing a video game 

i found the process of doing this, at base, kinda annoying on multiple fronts. for one, having to search amongst the entire set of emoji can be difficult, especially if it’s a symbol you don’t often use, so you forget the exact name or string to search for it. and it can be easy to forget certain symbols even exist without reference a note used to record all the symbols you use (in my case, a “Symbol Atlas”). 

that’s why i had the idea for this plugin. it essentially just presents a list of all the symbols on your Symbol Atlas, along with a description of what each symbol means to you. you can search based on either the emoji name *or* the meaning of that symbol, and quickly insert it. 

There’s also the option to append a predefined string after the symbol, in my case: `::`. this is useful for later querying these symbols using things like dataviewjs, to make tables or charts that include such emoji information. totally optional and user configurable. 

## Features

- **Symbol picker**
  - Open it from the command palette or with a hotkey (default:
    Cmd/Ctrl+Shift+E; change it in Settings → Hotkeys).
  - Fuzzy search by descriptor, subtitle, or the emoji's own name (typing
    "brain" finds 🧠, even inside combos like 🧠📺).
  - Sort by recently used or alphabetically.
  - Inserts the symbol at your cursor, optionally followed by text of your
    choice (e.g. `::`).
- **Your Symbol Atlas**
  - Manage symbols in settings: add, edit, and delete them, each with an
    optional subtitle for extra context.
  - Or keep them in a note: list items like `- 🧭:: how i'm feeling` under a
    heading you choose become symbols.
    - Sub-bullets under a symbol become its subtitle.
    - The list re-syncs whenever you save the note.
  - Import and export the list as JSON.
- **Sidebar** for quick inserting
  - A few totals at a glance, plus the symbols you've logged in today's note.
  - Your symbols as a list or a grid of emoji buttons. Tap one to insert it
    into the note you were editing, or copy it.
  - Filter, sort, and hide descriptions.
- **Stats page** for your journal
  - Activity heatmap, for all symbols or just one.
  - 30-day trend, coverage (how many daily notes have symbols), and symbols
    often logged together.
  - A card per symbol: times logged, last logged, frequency, streaks,
    weekday pattern, and recent entries linking to their notes.
  - Upkeep: symbols you use but haven't added to your atlas (one tap to add
    them), and symbols you haven't logged in a while.
  - Dates come from your daily notes' file names, in whatever format you use
    (e.g. `Journal 2026-10-05 Mon`).
  - Every stat can be switched on or off in settings.
- **Works on desktop, iPhone, and iPad.**

## Installing and updating

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/latest) into your vault's
`.obsidian/plugins/symbol-atlas/` folder (create it if needed), then enable
or reload Symbol Atlas in Settings → Community plugins. To update, replace
the same three files and restart Obsidian. Requires Obsidian 1.6.6 or newer.

## How data is stored

Symbols live inside Obsidian's own plugin data file:
`<vault>/.obsidian/plugins/symbol-atlas/data.json`
This is created automatically the first time you save a setting or add a
symbol. You can also copy/paste your list as JSON via the Import/Export
buttons in settings, e.g. to back it up or edit it in bulk.


## Customizing your Symbol Atlas

Go to Settings > Symbol Atlas. There you can:
- Add a new emoji + descriptor pair, with an optional subtitle.
- Edit or delete existing entries.
- Switch sort mode between "Recently used" and "Alphabetical".
- Set text to automatically insert after each symbol (e.g. `::`).
- Export your list as JSON, or paste in a JSON array to bulk-import.

### Sourcing symbols from a note instead

By default symbols are managed directly in the settings tab above. If you'd
rather maintain them as a list in a note you already keep (e.g. a "symbol
legend" note), switch **Symbol source** to "Vault note" and configure:
- **Source note** — start typing to search your vault, then pick a note.
- **Heading** — pick a level-2 (`##`) heading in that note. Every list item
  under it, at any nesting depth, of the form `- <emoji>:: <descriptor>`
  becomes a symbol. A sub-bullet directly under a symbol that does NOT
  itself contain `::` becomes that symbol's subtitle (shown under its name
  in the picker) — handy for a symbol that needs more explanation than the
  descriptor alone gives. Multiple such sub-bullets join into one subtitle.
  Any other list item without `::` is otherwise ignored, so you can freely
  mix in plain notes/comments. The section ends at the next `#`/`##`
  heading, so other sections in the same note are left alone.

The plugin re-syncs automatically whenever the note is saved, and there's
also a manual "Sync now" button. While in this mode, symbols are read-only
from the settings tab (edit the note instead); switching back to "Manual
list" leaves your most-recently-synced symbols in place as an editable
starting point.


## Sidebar and stats page

**The sidebar** (map icon in the ribbon, or "Open Symbol Atlas sidebar") is
for quick inserting. At the top it shows a few totals and what you've logged
in today's daily note, plus an **Open stats** button. Below that are your
symbols, as a list (with an optional one-line summary like "34× · last 3d
ago") or a grid of emoji buttons. Tap one to insert it at the cursor of the
last note you were editing; on a phone the sidebar closes afterwards. The
buttons next to the filter switch list/grid and hide/show descriptions for
the moment; their defaults are in settings.

**The stats page** opens as a tab ("Open stats" in the sidebar, or the "Open
Symbol Atlas stats" command) and has room for the details:
- **Overview**: symbols, entries in your notes, journal days, insertions,
  and your most logged / most inserted symbols.
- **Activity heatmap**: entries per day over the last year (half a year on
  narrow screens), for all symbols or one.
- **30-day trend**: the biggest changes between the last 30 days and the
  30 before.
- **Coverage**: how many daily notes have symbols, and how many per day.
- **Often logged together**: symbols that show up on the same days.
- **Upkeep**: *untracked symbols* (logged in notes but missing from your
  atlas, with a + to add them) and *dormant symbols* (not logged in 60+
  days, configurable).
- **A card per symbol**: count in vault, last logged, days logged in the
  last 30 with weekly bars, current and best streak, insert count, weekday
  pattern, and recent entries linking to their notes.

Every section can be switched on or off in settings.

**Set up your journal first.** Date-based stats come from your daily notes,
so in Settings → Symbol Atlas → Journal, set:
- **Daily notes folder**: e.g. `05 - Journal` (subfolders included; blank
  means the whole vault).
- **Daily note filename format**: the same syntax as the Daily Notes
  plugin. `YYYY` year, `MM`/`MMM` month, `DD`/`Do` day, `ddd` weekday, and
  other words in `[brackets]`. For notes named `Journal 2026-10-05 Mon`, use
  `[Journal] YYYY-MM-DD ddd`. The setting shows how many notes match.
  If the Daily Notes core plugin is on, you can copy its settings in one click.

An entry is a symbol followed by your suffix (e.g. `🧭:: tired but okay`).
The plugin keeps a small index of entries (`symbol-index.json` in the
plugin folder) and updates it as you edit, so stats stay current without
re-reading every note.

## Next steps / ideas

- Add tag/category fields to symbols for grouping.
- Add drag-to-reorder in settings.

## Releasing

1. Bump `version` in `manifest.json` and `package.json`, add a section to
   the version history below, and run `npm test && npm run build`.
2. Commit, then push an annotated tag named exactly the version (no `v`),
   whose message becomes the release notes:
   ```
   git tag -a 1.3.0 -F notes.md
   git push origin 1.3.0
   ```
   Or, from the GitHub website: Releases → "Draft a new release", create
   the tag (e.g. `1.3.0`) on `main`, write the notes, and publish.
3. The Release workflow builds the plugin and attaches `main.js`,
   `manifest.json`, and `styles.css` to the release.

## Version History

Every version is on the [releases page](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases).

### [v1.3.1](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/tag/1.3.1): stats page, journal stats, simpler sidebar

- **New stats page**, opened from the sidebar or the command palette: an
  activity heatmap, 30-day trend, coverage, symbols logged together, upkeep
  (untracked and dormant symbols), and a card per symbol with last logged,
  frequency, streaks, weekday pattern and recent entries.
- **Journal settings**: point the plugin at your daily notes folder and
  filename format (e.g. `[Journal] YYYY-MM-DD ddd`) so each note's date is
  read from its name.
- **Simpler sidebar** for quick inserting: a few totals, today's symbols, an
  "Open stats" button, and the symbols as a list or a grid of emoji buttons.
- Every stat can be shown or hidden in settings, and the sidebar's layout and
  descriptions have settings defaults.
- Symbols are counted from a saved index that updates as you edit, so
  there's no "Scan vault" button anymore. Counting is also more accurate:
  `📺::` is no longer counted inside `🧠📺::`.
- The sidebar uses Obsidian's interface font size (like the file explorer)
  instead of the larger editor text size.
- The chips in the sidebar are display-only; tapping them no longer inserts
  the symbol.
- Inserting from the sidebar works even when the stats page is the active tab.

### [v1.3.0](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/tag/1.3.0): sidebar with stats, more reliable note source on mobile

- **Fix:** the "source note not found" notice that showed on every launch
  on iPad/iPhone. The startup sync used to run before Obsidian had finished
  indexing the vault (which takes longer on mobile, especially with
  iCloud), so the note looked missing even though it existed. The sync now
  waits until the vault is ready.
- **Fix:** the source note path and heading are now matched tolerantly:
  Unicode normalization differences between devices (iOS can store
  accented characters differently), letter case, a missing `.md`, and a
  note moved to another folder while the plugin wasn't running (matched by
  file name when it's unique). When a looser match is found, the saved path
  is corrected.
- **Fix:** an edit to the source note made while a sync was already
  running was dropped; it now re-syncs right after.
- New sidebar tab with statistics and the full symbol list.
- Symbols now track how many times they've been inserted.
- Manually managed symbols can now have a subtitle (add/edit dialogs).
- The picker also searches subtitles.
- Note parsing also accepts tab-indented sub-bullets mixed with spaces,
  task items (`- [ ] 🧭:: …`), and numbered lists (`1. 🧭:: …`).
- New commands: "Open Symbol Atlas sidebar", "Sync symbols from source
  note".
- Copying to the clipboard now reports failures instead of failing silently.

### [v1.2.1](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/tag/1.2.1): symbol subtitles from note sub-bullets

When sourcing symbols from a note, a sub-bullet directly under a symbol
that doesn't itself contain `::` now becomes that symbol's subtitle,
shown under its name in the picker (see "Sourcing symbols from a note
instead" above). No settings changes — this only affects vault-note mode.

### [v1.2.0](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/tag/1.2.0): toolbar icon, auto-inserted suffix, and note-sourced symbols

- The command now has a proper icon (smiley-plus) instead of a generic
  question mark in the command palette / toolbar.
- New setting: text to automatically insert after each symbol (e.g. `::`),
  so you don't have to type it by hand every time.
- New **Symbol source** setting: instead of managing symbols only in the
  settings tab, you can point the plugin at a note plus a `##` heading in
  your vault and it mirrors the `- <emoji>:: <descriptor>` list items under
  it automatically, syncing whenever you save the note. See "Sourcing
  symbols from a note instead" above.
- Editing and deleting a symbol now use proper in-app dialogs instead of
  browser prompts, and delete/import ask for confirmation first.
- Requires Obsidian **1.6.6** or newer (bumped from 1.1.0) — the note-source
  feature relies on newer Obsidian APIs.

### [v1.1.0](https://github.com/Tigertenzin/obsidian-symbol-atlas/releases/tag/1.1.0): first release, with search by emoji name

The picker now matches against both your descriptor text AND the emoji's
official Unicode name (e.g. typing "brain" will find 🧠 even if your
descriptor is "Deeper Thoughts"). This uses the small `gemoji` package to
look up names, and works for multi-emoji combos too (e.g. "🧠📺" matches
"brain" or "television").
