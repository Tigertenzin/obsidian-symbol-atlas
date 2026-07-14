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
- Export your list as JSON, or paste in a JSON array to bulk-import.

## Project structure

```
obsidian-symbol-atlas/
├── main.ts             # All plugin logic (modal, settings tab, commands)
├── manifest.json        # Plugin metadata Obsidian reads
├── package.json         # npm dependencies + build scripts
├── tsconfig.json         # TypeScript compiler config
├── esbuild.config.mjs    # Bundles main.ts -> main.js
├── styles.css            # Picker styling
└── README.md
```

## Next steps / ideas

- Add tag/category fields to symbols for grouping.
- Add drag-to-reorder in settings.
- Sync the JSON symbol list via a note in your vault instead of data.json,
  so it travels with vault sync tools.


## v1.1 update: search by emoji name too

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
