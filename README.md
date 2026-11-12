# Impeccable 5.2

**Write flawlessly.**

A distraction-free word processor for the web, in the spirit of WordPerfect 5.1 for DOS: the blue screen, the status line, Reveal Codes and the function keys, with modern selection and clipboard keys. Documents are plain Markdown files.

It runs as an installable, offline-capable PWA from GitHub Pages.

## Features

- The VGA blue screen, with bold in bright white, italic in cyan, headings in yellow and blocked text in reverse video
- The status line: `Doc 1 Pg 1 Ln 1" Pos 1"`, with Pos taking on the attribute under the cursor
- Reveal Codes (Alt+F3) switches between formatted text and the Markdown underneath
- Optional WordPerfect 5.1 keys: F10 save, F7 exit, F6 bold, F8 underline, Alt+F4 or F12 block, Home Home ↑ and more
- The WP 5.1 pull-down menu bar on Alt+=
- Modern keys always work: Shift+arrows, Ctrl+X/C/V, Ctrl+Z/Y, Ctrl+S, Ctrl+B/I/U
- Setup screen (Shift+F1): WP keys, 80-column page, text size, touch key strip, spell check, cursor
- A colour-coded "keyboard template" strip for touch screens, so phones and foldables get the function keys too
- Saves to real files where the browser allows it; otherwise downloads and shares `.md` files
- Keeps your work in the browser as you type, so closing the tab loses nothing
- Prints in Courier 10 pitch with 1-inch margins, as WP did

## Markdown it writes

| Format     | Markdown              |
|------------|-----------------------|
| Bold       | `**text**`            |
| Italic     | `_text_`              |
| Underline  | `<u>text</u>`         |
| Headings   | `# `, `## `, `### `   |
| Lists      | `- item`              |

Markdown has no underline, so `<u>` tags are used; most Markdown viewers, including GitHub, display them.

## Browser support

| Where                         | Files                                                        |
|-------------------------------|--------------------------------------------------------------|
| Chrome or Edge on a computer  | Opens and saves files in place. Installed, `.md` files can open straight into it. |
| Android (Chrome)              | Retrieve uses the file picker; Save asks for a name and downloads; Share sends the file to other apps. |
| Safari, Firefox               | As on Android.                                               |

Browsers reserve some keys in an ordinary tab, including Ctrl+N, Ctrl+W, F11 and F12, and Windows always keeps Alt+F4. Install Impeccable as an app to free most of them, or use the alternatives listed in Help (F1, or F3 with WP keys on).

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, set the source to **Deploy from a branch**, branch `main`, folder `/docs`.
3. Visit `https://<username>.github.io/<repository>/`.

The `docs` folder is the whole app. It needs no build step to publish.

## Change the code

The source is `src/main.js`; `docs/app.js` is the built bundle.

```sh
npm install
npm run build    # or: npm run watch
npm run serve    # http://localhost:8000
```

When you publish a change, also bump `CACHE` in `docs/sw.js` so installed copies update.

## Credits

- [CodeMirror 6](https://codemirror.net/) for the editor (MIT)
- [marked](https://marked.js.org/) for printing (MIT)
- [VT323](https://fonts.google.com/specimen/VT323) by Peter Hull (SIL OFL 1.1)

Impeccable is an independent tribute and is not affiliated with Corel Corporation. WordPerfect is a trademark of Corel.

## Licence

MIT
