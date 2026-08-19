# Symbol Atlas — Obsidian Plugin

A custom emoji-style picker for Obsidian, populated entirely from my "Symbol Atlas": a list of {emoji, descriptor} 

## Features

- Open the picker via the Command Palette or a keyboard shortcut
  (default: Cmd/Ctrl+Shift+E — change it anytime in Settings > Hotkeys).
- Fuzzy search by descriptor name.
- Sort by "Recently used" or "Alphabetical" (toggle in plugin settings).
- Add, edit, and delete symbols directly from the settings tab — no manual
  JSON editing required (though import/export JSON is also supported).
- Selecting a symbol inserts the emoji at your cursor and updates its
  "last used" timestamp.

## How it's stored

Symbols live inside Obsidian's own plugin data file:
`<vault>/.obsidian/plugins/symbol-atlas/data.json`
This is created automatically the first time you save a setting or add a
symbol. You can also copy/paste your list as JSON via the Import/Export
buttons in settings, e.g. to back it up or edit it in bulk.

## Setup instructions (one-time)

You need Node.js installed to compile this plugin into the `main.js` file
Obsidian actually loads. TypeScript source is not run directly.

1. Install Node.js (v18+) from https://nodejs.org if you don't have it.
2. Open a terminal in this folder (`obsidian-symbol-atlas`).
3. Run:
   ```
   npm install
   npm run build
   ```
   This creates `main.js` in the same folder.
4. Copy this entire folder into your vault at:
   `<YourVault>/.obsidian/plugins/symbol-atlas/`
   (create the `plugins` folder if it doesn't exist).
5. In Obsidian: Settings > Community plugins > turn off "Restricted mode"
   if needed, then enable "Symbol Atlas" in the installed plugins list.
6. Open the Command Palette (Cmd/Ctrl+P) and run "Open Symbol Atlas picker",
   or use the default hotkey Cmd/Ctrl+Shift+E.

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


## Next steps / ideas

- Add tag/category fields to symbols for grouping.
- Add drag-to-reorder in settings.

## Version History

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
