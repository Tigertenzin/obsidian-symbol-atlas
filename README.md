# Symbol Atlas — Obsidian Plugin

A custom emoji-style picker for Obsidian, populated entirely from my "Symbol Atlas": a list of {emoji, descriptor} 

## methodology 

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

- Open the picker via the Command Palette or a keyboard shortcut
  (default: Cmd/Ctrl+Shift+E — change it anytime in Settings > Hotkeys).
- Fuzzy search by descriptor name.
- Sort by "Recently used" or "Alphabetical" (toggle in plugin settings).
- Add, edit, and delete symbols directly from the settings tab — no manual
  JSON editing required (though import/export JSON is also supported).
- Selecting a symbol inserts the emoji at your cursor and updates its
  "last used" timestamp and use count.
- A **Symbol Atlas sidebar tab** (ribbon map icon, or the "Open Symbol
  Atlas sidebar" command) with usage statistics and the full, filterable
  symbol list. Tap a symbol to insert it into the note you were last
  editing, or use its copy button.

## How data is stored

Symbols live inside Obsidian's own plugin data file:
`<vault>/.obsidian/plugins/symbol-atlas/data.json`
This is created automatically the first time you save a setting or add a
symbol. You can also copy/paste your list as JSON via the Import/Export
buttons in settings, e.g. to back it up or edit it in bulk.


## Customizing your Symbol Atlas

Go to Settings > Symbol Atlas. There you can:
- Add a new emoji + descriptor pair.
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


## Sidebar: statistics and full list

Open it from the ribbon (map icon) or the command palette ("Open Symbol
Atlas sidebar"). It shows:
- **Totals**: number of symbols, total insertions, how many you've used, and
  how many you've never used.
- **Top**: your most-inserted symbols (counted from v1.3 onward; older usage
  only has a "last used" time).
- **Scan vault**: on demand, counts how often each symbol appears across
  your notes (excluding the source note). If you've set a suffix like `::`,
  it counts `<emoji>::`, which matches how entries are logged and avoids
  counting 🧠 inside 🧠📺. `⭐` and `⭐️` count as the same symbol.
- **Full list**: filter by descriptor, subtitle, or emoji name, and sort by
  recent, A–Z, most used, or vault count. Tap a row to insert it at the
  cursor of the last note you were editing; on a phone the sidebar closes
  afterwards so you can see it.

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

### v1.3.0 update: sidebar with stats, more reliable note source on mobile

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
- New sidebar tab with statistics and the full symbol list (see above).
- Symbols now track how many times they've been inserted.
- Manually managed symbols can now have a subtitle (add/edit dialogs).
- The picker also searches subtitles.
- Note parsing also accepts tab-indented sub-bullets mixed with spaces,
  task items (`- [ ] 🧭:: …`), and numbered lists (`1. 🧭:: …`).
- New commands: "Open Symbol Atlas sidebar", "Sync symbols from source
  note".
- Copying to the clipboard now reports failures instead of failing silently.

### v1.2.1 update: symbol subtitles from note sub-bullets

When sourcing symbols from a note, a sub-bullet directly under a symbol
that doesn't itself contain `::` now becomes that symbol's subtitle,
shown under its name in the picker (see "Sourcing symbols from a note
instead" above). No settings changes — this only affects vault-note mode.

### v1.2 update: toolbar icon, auto-inserted suffix, and note-sourced symbols

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

### Updating from v1.1

1. Replace `main.ts`, `package.json`, and `manifest.json` in your project
   folder with the new versions from this package.
2. In a terminal, in the project folder, run:
   ```
   npm run build
   ```
   (no `npm install` needed — no new dependencies were added.)
3. Copy the freshly generated `main.js`, plus the updated `manifest.json`,
   into your vault's `<YourVault>/.obsidian/plugins/symbol-atlas/` folder,
   overwriting the old ones. `styles.css` doesn't need to change.
4. In Obsidian, reload the plugin: Settings > Community plugins > toggle
   Symbol Atlas off then on again (or just restart Obsidian).

### v1.1 update: search by emoji name too

The picker now matches against both your descriptor text AND the emoji's
official Unicode name (e.g. typing "brain" will find 🧠 even if your
descriptor is "Deeper Thoughts"). This uses the small `gemoji` package to
look up names, and works for multi-emoji combos too (e.g. "🧠📺" matches
"brain" or "television").

### Updating from v1.0

1. Replace `main.ts` and `package.json` in your project folder with the
   new versions from this package.
2. In a terminal, in the project folder, run:
   ```
   npm install
   npm run build
   ```
   (`npm install` is required this time because gemoji is a new dependency.)
3. Copy the freshly generated `main.js` into your vault's
   `<YourVault>/.obsidian/plugins/symbol-atlas/` folder, overwriting the
   old one. `manifest.json` and `styles.css` don't need to change.
4. In Obsidian, reload the plugin: Settings > Community plugins > toggle
   Symbol Atlas off then on again (or just restart Obsidian).
