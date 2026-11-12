// Impeccable 5.2 — Write flawlessly.
// A distraction-free Markdown word processor in the spirit of WordPerfect 5.1 for DOS.
// MIT licence. Not affiliated with Corel or WordPerfect.

import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, drawSelection, Decoration, ViewPlugin, WidgetType, highlightSpecialChars,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll,
  selectCharLeft, selectCharRight, selectGroupLeft, selectGroupRight, selectLineUp, selectLineDown,
  selectLineBoundaryBackward, selectLineBoundaryForward, selectDocStart, selectDocEnd,
  selectPageUp, selectPageDown, cursorDocStart, cursorDocEnd, cursorPageUp, cursorPageDown,
  cursorLineBoundaryForward, cursorLineBoundaryBackward,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";

const VERSION = "5.2.0";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------- storage */

const store = {
  get(k, d) { try { const v = localStorage.getItem("impeccable." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("impeccable." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// File handles can't go in localStorage, so they live in IndexedDB.
const idb = {
  db: null,
  open() {
    if (!this.db) this.db = new Promise((res, rej) => {
      const r = indexedDB.open("impeccable", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const q = db.transaction("kv").objectStore("kv").get(k);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
    } catch { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch { /* ignore */ }
  },
};

/* --------------------------------------------------------------- settings */

const DEFAULTS = { wpKeys: false, col80: true, size: "auto", template: "auto", spell: false, cursor: "underscore" };
const settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
const CHOICES = { size: ["auto", "small", "medium", "large"], template: ["auto", "on", "off"], cursor: ["underscore", "bar"] };

/* ------------------------------------------------------------- doc state */

const docState = { name: store.get("name", ""), handle: null, dirty: store.get("dirty", false) };
let reveal = false;
let blockOn = false;
let message = "";
let messageTimer = 0;
let modalKey = null;   // keyboard handler for an active status-line prompt
let screenKey = null;  // keyboard handler for a full-screen page (Setup, Help)

/* ------------------------------------------------------- editor: visuals */

const wpHighlight = HighlightStyle.define([
  { tag: t.strong, color: "var(--bright)" },
  { tag: t.emphasis, color: "var(--italic)", fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--yellow)" },
  { tag: t.monospace, color: "var(--green)" },
  { tag: t.link, color: "var(--cyan)", textDecoration: "underline" },
  { tag: t.url, color: "var(--dcyan)" },
  { tag: t.quote, color: "var(--dcyan)" },
  { tag: t.contentSeparator, color: "var(--dcyan)" },
  { tag: t.processingInstruction, class: "cm-mk" },
]);

class BulletWidget extends WidgetType {
  toDOM() { const s = document.createElement("span"); s.textContent = "•"; s.className = "cm-bullet"; return s; }
  eq() { return true; }
}
const hiddenDeco = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const HIDE = new Set(["EmphasisMark", "HeaderMark", "CodeMark", "StrikethroughMark"]);
const U_TAG = /<\/?u>/g;
const U_SPAN = /<u>([^]*?)<\/u>/g;

function eachVisibleLine(view, fn) {
  const { doc } = view.state;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) { const line = doc.lineAt(pos); fn(line); pos = line.to + 1; }
  }
}

// Normal view hides Markdown codes, like WP 5.1 hid its formatting codes.
function buildHidden(view) {
  const { state } = view;
  const out = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.name === "ListMark") {
          if (/^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) out.push(bulletDeco.range(node.from, node.to));
        } else if (HIDE.has(node.name)) {
          let end = node.to;
          if (node.name === "HeaderMark" && state.doc.sliceString(end, end + 1) === " ") end++;
          if (end > node.from) out.push(hiddenDeco.range(node.from, end));
        }
      },
    });
  }
  eachVisibleLine(view, (line) => {
    for (const m of line.text.matchAll(U_TAG)) out.push(hiddenDeco.range(line.from + m.index, line.from + m.index + m[0].length));
  });
  return Decoration.set(out, true);
}

const hidePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildHidden(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildHidden(u.view);
  }
}, {
  decorations: (v) => v.decorations,
  provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
});

// Markdown has no underline, so <u>…</u> is used; this draws it.
const uDeco = Decoration.mark({ class: "cm-u" });
const tagDeco = Decoration.mark({ class: "cm-mk" });
function buildUnderline(view) {
  const out = [];
  eachVisibleLine(view, (line) => {
    for (const m of line.text.matchAll(U_SPAN)) {
      const s = line.from + m.index, e = s + m[0].length;
      out.push(tagDeco.range(s, s + 3));
      if (m[1].length) out.push(uDeco.range(s + 3, e - 4));
      out.push(tagDeco.range(e - 4, e));
    }
  });
  return Decoration.set(out, true);
}
const underlinePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildUnderline(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildUnderline(u.view); }
}, { decorations: (v) => v.decorations });

// Blocked (selected) text shows in reverse video: blue on grey.
const blockedDeco = Decoration.mark({ class: "cm-blocked" });
const blockPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view.state); }
  update(u) { if (u.selectionSet || u.docChanged) this.decorations = this.build(u.state); }
  build(s) { return Decoration.set(s.selection.ranges.filter((r) => !r.empty).map((r) => blockedDeco.range(r.from, r.to)), true); }
}, { decorations: (v) => v.decorations });

const wpTheme = EditorView.theme({
  "&": { color: "var(--grey)", backgroundColor: "transparent", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.25" },
  ".cm-content": { caretColor: "transparent", padding: "0" },
  ".cm-line": { padding: "0" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--grey)" },
}, { dark: true });

const hideComp = new Compartment();
const spellComp = new Compartment();
const spellExt = () => EditorView.contentAttributes.of({
  spellcheck: settings.spell ? "true" : "false",
  autocorrect: settings.spell ? "on" : "off",
  autocapitalize: "sentences",
  "aria-label": "Document",
});

let draftTimer = 0;
const onUpdate = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    if (!docState.dirty) setDirty(true);
    if (blockOn) blockOn = false;
    if (message && !messageTimer) message = "";
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 400);
  }
  if (u.docChanged || u.selectionSet) updateStatus();
});

function makeState(doc) {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection({ cursorBlinkRate: reduceMotion ? 0 : 1000 }),
      highlightSpecialChars(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(wpHighlight),
      search({ top: false }),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      hideComp.of(reveal ? [] : hidePlugin),
      underlinePlugin,
      blockPlugin,
      spellComp.of(spellExt()),
      onUpdate,
      wpTheme,
    ],
  });
}

/* ------------------------------------------------------------- DOM refs */

const statusEl = $("#status");
const leftEl = $("#status-left");
const rightEl = $("#status-right");
const promptEl = $("#prompt");
const menubar = $("#menubar");
const dropEl = $("#menu-drop");
const templateEl = $("#template");
const screenEl = $("#screen");
const fileInput = $("#file-input");
const printArea = $("#print-area");

const view = new EditorView({ state: makeState(store.get("draft", "")), parent: $("#editor") });

/* ------------------------------------------------------------ status line */

const inches = (n) => n.toFixed(2).replace(/\.?0+$/, "") + '"';

function attrsAt(state, pos) {
  const a = { b: false, i: false, u: false };
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "StrongEmphasis") a.b = true;
    else if (n.name === "Emphasis") a.i = true;
  }
  const line = state.doc.lineAt(pos), col = pos - line.from;
  for (const m of line.text.matchAll(U_SPAN)) if (col >= m.index + 3 && col <= m.index + m[0].length - 4) a.u = true;
  return a;
}

function displayName() { return docState.name || (docState.dirty ? "Untitled" : ""); }

function updateStatus() {
  if (message) leftEl.textContent = message;
  else if (blockOn) leftEl.innerHTML = '<span class="blink">Block on</span>';
  else leftEl.textContent = displayName();
  document.title = `${docState.name || "Untitled"}${docState.dirty ? " •" : ""} – Impeccable 5.2`;
  view.requestMeasure({ key: "status", read: measurePosition, write: writePosition });
}

// WP counted 6 lines per inch, 54 lines per page and 10 characters per inch,
// with 1-inch margins. Lines are counted as they appear on screen, wrapping
// included, and hidden codes don't count towards Pos, just as in WP.
function measurePosition(v) {
  const head = v.state.selection.main.head;
  const c = v.coordsAtPos(head, 1) || v.coordsAtPos(head, -1);
  const idx = c ? Math.max(0, Math.round((c.top - v.documentTop) / v.defaultLineHeight)) : v.state.doc.lineAt(head).number - 1;
  const start = v.moveToLineBoundary(EditorSelection.cursor(head), false).head;
  return { head, idx, start: Math.min(start, head) };
}

function writePosition({ head, idx, start }, v) {
  let col = head - start;
  const plug = reveal ? null : v.plugin(hidePlugin);
  if (plug) plug.decorations.between(start, head, (f, to, d) => { if (!d.spec.widget) col -= Math.min(to, head) - Math.max(f, start); });
  const a = attrsAt(v.state, head);
  const cls = ["pos", a.b && "b", a.i && "i", a.u && "u"].filter(Boolean).join(" ");
  rightEl.innerHTML = `Doc 1 Pg ${Math.floor(idx / 54) + 1} Ln ${inches(1 + (idx % 54) / 6)} <span class="${cls}">Pos ${inches(1 + Math.max(0, col) / 10)}</span>`;
}

function msg(text, ms = 2500) {
  message = text;
  clearTimeout(messageTimer);
  messageTimer = ms ? setTimeout(() => { message = ""; messageTimer = 0; updateStatus(); }, ms) : 0;
  updateStatus();
}

function setDirty(v) { docState.dirty = v; store.set("dirty", v); updateStatus(); }
function persistDraft() { store.set("draft", view.state.doc.toString()); store.set("name", docState.name); }

/* ------------------------------------------------- status-line prompts */

function showPrompt(html) { promptEl.innerHTML = html; statusEl.classList.add("prompting"); promptEl.hidden = false; }
function hidePrompt() { promptEl.hidden = true; promptEl.innerHTML = ""; statusEl.classList.remove("prompting"); modalKey = null; }

// "Save document? Yes (No)" — the unbracketed answer is the default.
function promptYesNo(q, def = true) {
  return new Promise((res) => {
    const [a, b] = def ? ["Yes", "No"] : ["No", "Yes"];
    showPrompt(`${esc(q)} <button class="opt" data-v="${def}">${a}</button> (<button class="opt" data-v="${!def}">${b}</button>)`);
    const done = (v) => { hidePrompt(); promptEl.onclick = null; res(v); };
    promptEl.onclick = (e) => { const o = e.target.closest(".opt"); if (o) done(o.dataset.v === "true"); };
    modalKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      const k = e.key.toLowerCase();
      if (k === "y") done(true);
      else if (k === "n") done(false);
      else if (k === "enter") done(def);
      else if (k === "escape" || k === "f1") done(null);
    };
  });
}

function promptText(label, value = "") {
  return new Promise((res) => {
    showPrompt(`<label>${esc(label)} <input id="prompt-input" spellcheck="false" autocomplete="off" enterkeyhint="done"></label>`);
    const inp = $("#prompt-input");
    inp.value = value; inp.focus(); inp.select();
    const done = (v) => { hidePrompt(); view.focus(); res(v); };
    modalKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(inp.value.trim() || null); }
      else if (e.key === "Escape" || e.key === "F1") { e.preventDefault(); done(null); }
    };
  });
}

/* ------------------------------------------------------------------ files */

const PICK_TYPES = [{ description: "Markdown or text", accept: { "text/markdown": [".md", ".markdown"], "text/plain": [".txt"] } }];
const canOpenFS = "showOpenFilePicker" in window;
const canSaveFS = "showSaveFilePicker" in window;

async function confirmDiscard() {
  if (!docState.dirty || !view.state.doc.length) return true;
  const r = await promptYesNo(`Save ${displayName()}?`, true);
  if (r === null) { view.focus(); return false; }
  return r ? await saveDoc(false) : true;
}

function loadText(text, name, handle) {
  view.setState(makeState(text));
  docState.name = name; docState.handle = handle;
  idb.set("handle", handle || null);
  setDirty(false); persistDraft();
  msg(`Retrieved ${name}`);
  view.focus();
}

async function loadHandle(h) { const f = await h.getFile(); loadText(await f.text(), f.name, h); }

async function openDoc() {
  if (!(await confirmDiscard())) return;
  if (canOpenFS) {
    try { const [h] = await window.showOpenFilePicker({ types: PICK_TYPES }); await loadHandle(h); }
    catch (e) { if (e.name !== "AbortError") msg("Could not open that file"); view.focus(); }
  } else fileInput.click();
}
fileInput.addEventListener("change", async () => {
  const f = fileInput.files[0];
  if (f) loadText(await f.text(), f.name, null);
  fileInput.value = "";
});

async function ensurePermission(h) {
  const o = { mode: "readwrite" };
  if ((await h.queryPermission(o)) === "granted") return true;
  return (await h.requestPermission(o)) === "granted";
}
async function writeHandle(h, text) { const w = await h.createWritable(); await w.write(text); await w.close(); }

function downloadText(text, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function saved() { setDirty(false); persistDraft(); msg(`Saved ${docState.name}`); view.focus(); return true; }

async function saveDoc(asNew) {
  const text = view.state.doc.toString();
  if (!asNew && docState.handle?.createWritable) {
    try { if (await ensurePermission(docState.handle)) { await writeHandle(docState.handle, text); return saved(); } }
    catch { /* fall through to Save as */ }
  }
  if (canSaveFS) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: docState.name || "untitled.md", types: PICK_TYPES });
      await writeHandle(h, text);
      docState.handle = h; docState.name = h.name; idb.set("handle", h);
      return saved();
    } catch (e) {
      if (e.name !== "AbortError") msg("Could not save that file");
      view.focus(); return false;
    }
  }
  // Phones and Safari/Firefox: ask for a name, then download, as WP did with F10.
  const name = await promptText("Document to be saved:", docState.name || "untitled.md");
  if (!name) return false;
  docState.name = /\.\w+$/.test(name) ? name : name + ".md";
  downloadText(text, docState.name);
  return saved();
}

async function shareDoc() {
  const name = docState.name || "untitled.md";
  const text = view.state.doc.toString();
  const file = new File([text], name, { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
    else if (navigator.share) await navigator.share({ title: name, text });
    else msg("Sharing isn't available in this browser");
  } catch { /* cancelled */ }
  view.focus();
}

async function newDoc() {
  if (!(await confirmDiscard())) return;
  view.setState(makeState(""));
  docState.name = ""; docState.handle = null; idb.set("handle", null);
  blockOn = false; setDirty(false); persistDraft();
  view.focus();
}

// F7: "Save document? Yes (No)" then "Exit document? No (Yes)".
async function exitDoc() {
  const s = await promptYesNo("Save document?", true);
  if (s === null) { view.focus(); return; }
  if (s && !(await saveDoc(false))) return;
  const c = await promptYesNo("Exit document?", false);
  if (c) { docState.dirty = false; await newDoc(); } else view.focus();
}

/* -------------------------------------------------------------- printing */

marked.use({
  breaks: true,
  renderer: {
    // Allow <u> through; escape any other raw HTML in a document.
    html(token) { const s = typeof token === "string" ? token : token.text; return s.replace(/<(?!\/?u>)/g, "&lt;"); },
  },
});

function printDoc() {
  printArea.innerHTML = marked.parse(view.state.doc.toString()).replace(/href="\s*javascript:[^"]*"/gi, 'href="#"');
  window.print();
  view.focus();
}

/* ------------------------------------------------------------ formatting */

function toggleWrap(open, close = open) {
  const { state } = view;
  view.dispatch(state.changeByRange((r) => {
    const { from, to } = r, doc = state.doc;
    if (doc.sliceString(from - open.length, from) === open && doc.sliceString(to, to + close.length) === close) {
      return {
        changes: [{ from: from - open.length, to: from }, { from: to, to: to + close.length }],
        range: EditorSelection.range(from - open.length, to - open.length),
      };
    }
    const sel = doc.sliceString(from, to);
    if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
      return {
        changes: { from, to, insert: sel.slice(open.length, sel.length - close.length) },
        range: EditorSelection.range(from, to - open.length - close.length),
      };
    }
    return {
      changes: [{ from, insert: open }, { from: to, insert: close }],
      range: EditorSelection.range(from + open.length, to + open.length),
    };
  }), { scrollIntoView: true, userEvent: "input" });
  view.focus();
}

function setHeading(level) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue; seen.add(n);
      const line = state.doc.line(n);
      const m = /^#{1,6}\s+/.exec(line.text);
      changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: level ? "#".repeat(level) + " " : "" });
    }
  }
  view.dispatch({ changes, userEvent: "input" });
  view.focus();
}

/* --------------------------------------------------------- block & codes */

function toggleBlock(force) {
  blockOn = typeof force === "boolean" ? force : !blockOn;
  if (blockOn) { message = ""; clearTimeout(messageTimer); messageTimer = 0; }
  if (!blockOn) { const h = view.state.selection.main.head; view.dispatch({ selection: { anchor: h } }); }
  updateStatus(); view.focus();
}

function toggleReveal() {
  reveal = !reveal;
  view.dispatch({ effects: hideComp.reconfigure(reveal ? [] : hidePlugin) });
  document.body.classList.toggle("reveal", reveal);
  msg(reveal ? "Reveal Codes on" : "Reveal Codes off");
  view.focus();
}

function cancel() {
  closeSearchPanel(view);
  if (blockOn) toggleBlock(false);
  message = ""; updateStatus(); view.focus();
}

/* -------------------------------------------------------------- clipboard */

async function copySel(cut) {
  const s = view.state;
  const text = s.selection.ranges.map((r) => s.sliceDoc(r.from, r.to)).join("\n");
  if (!text) { msg("Block some text first"); return view.focus(); }
  try {
    await navigator.clipboard.writeText(text);
    if (cut) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
    msg(cut ? "Cut" : "Copied");
  } catch { msg("Clipboard blocked here. Use Ctrl+C."); }
  view.focus();
}
async function pasteClip() {
  try {
    const text = await navigator.clipboard.readText();
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  } catch { msg("Clipboard blocked here. Use Ctrl+V."); }
  view.focus();
}

function wordCount() {
  const n = (view.state.doc.toString().replace(/<\/?u>|[#*_`>~|-]+/g, " ").match(/\S+/g) || []).length;
  msg(`${n.toLocaleString()} word${n === 1 ? "" : "s"}`, 5000);
  view.focus();
}

function toggleSpell() {
  settings.spell = !settings.spell; saveSettings();
  msg(settings.spell ? "Spell check on" : "Spell check off");
  view.focus();
}

/* ---------------------------------------------------------------- commands */

const COMMANDS = {
  new: newDoc, open: openDoc, save: () => saveDoc(false), saveAs: () => saveDoc(true),
  share: shareDoc, print: printDoc, exit: exitDoc,
  undo: () => { undo(view); view.focus(); }, redo: () => { redo(view); view.focus(); },
  cut: () => copySel(true), copy: () => copySel(false), paste: pasteClip,
  block: () => toggleBlock(), selectAll: () => { selectAll(view); view.focus(); }, reveal: toggleReveal,
  find: () => openSearchPanel(view),
  replace: () => { openSearchPanel(view); setTimeout(() => view.dom.querySelector(".cm-search input[name=replace]")?.focus(), 0); },
  bold: () => toggleWrap("**"), italic: () => toggleWrap("_"), underline: () => toggleWrap("<u>", "</u>"),
  h1: () => setHeading(1), h2: () => setHeading(2), h3: () => setHeading(3), h0: () => setHeading(0),
  count: wordCount, spell: toggleSpell, setup: showSetup, help: showHelp, about: showAbout,
  menu: openMenu, cancel,
};
function run(name) { const fn = COMMANDS[name]; if (fn) fn(); }

/* --------------------------------------------------------------- keyboard */

// Everyday keys work in both modes.
const MODERN = {
  "C-s": "save", "C-S-s": "saveAs", "C-o": "open", "C-n": "new", "C-p": "print",
  "C-b": "bold", "C-i": "italic", "C-u": "underline",
  "A-1": "h1", "A-2": "h2", "A-3": "h3", "A-0": "h0",
  "C-f": "find", "C-h": "replace",
  "A-F3": "reveal", "S-F1": "setup", "A-equal": "menu", F1: "help",
};
// WordPerfect 5.1 keys, switched on in Setup. These win over the everyday keys.
const WPKEYS = {
  F1: "cancel", F2: "find", "S-F2": "find", "A-F2": "replace", F3: "help",
  "A-F3": "reveal", F11: "reveal", F5: "open", "S-F10": "open",
  F6: "bold", F8: "underline", "C-F8": "italic", F7: "exit", F10: "save",
  "S-F7": "print", "S-F1": "setup", "C-F2": "spell", F12: "block", "A-F4": "block", "A-equal": "menu",
};

function comboOf(e) {
  let k = e.key;
  if (k.length === 1 || e.code === "Equal") k = e.code.replace(/^Key|^Digit/, "").toLowerCase();
  return (e.ctrlKey || e.metaKey ? "C-" : "") + (e.altKey ? "A-" : "") + (e.shiftKey ? "S-" : "") + k;
}

const keyLabel = (c) => c.replace("C-", "Ctrl+").replace("A-", "Alt+").replace("S-", "Shift+").replace("equal", "=").replace(/\+([a-z])$/, (m, l) => "+" + l.toUpperCase());

function shortcutFor(cmd) {
  const find = (map) => Object.keys(map).find((k) => map[k] === cmd);
  const k = (settings.wpKeys && find(WPKEYS)) || find(MODERN);
  return k ? keyLabel(k) : "";
}

const BLOCK_NAV = {
  ArrowLeft: [selectCharLeft, selectGroupLeft], ArrowRight: [selectCharRight, selectGroupRight],
  ArrowUp: [selectLineUp, selectLineUp], ArrowDown: [selectLineDown, selectLineDown],
  Home: [selectLineBoundaryBackward, selectDocStart], End: [selectLineBoundaryForward, selectDocEnd],
  PageUp: [selectPageUp, selectPageUp], PageDown: [selectPageDown, selectPageDown],
};

let homeCount = 0, homeTimer = 0;

function onKey(e) {
  if (screenKey) return screenKey(e);
  if (modalKey) return modalKey(e);
  if (!menubar.hidden) return menuKey(e);

  const c = comboOf(e);
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  const inEditor = view.contentDOM.contains(document.activeElement);

  // Home sequences from WP: Home Home ↑ / ↓ for top and bottom of the document.
  if (settings.wpKeys && inEditor) {
    if (e.key === "Home" && plain) {
      homeCount++; clearTimeout(homeTimer);
      homeTimer = setTimeout(() => { homeCount = 0; }, 1200);
      if (homeCount > 1) e.preventDefault();
      if (!blockOn) return;
    } else if (homeCount && plain && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      const up = e.key === "ArrowUp", n = homeCount; homeCount = 0;
      if (e.key === "ArrowLeft") return (blockOn ? selectLineBoundaryBackward : cursorLineBoundaryBackward)(view);
      if (e.key === "ArrowRight") return (blockOn ? selectLineBoundaryForward : cursorLineBoundaryForward)(view);
      if (n >= 2) return (blockOn ? (up ? selectDocStart : selectDocEnd) : (up ? cursorDocStart : cursorDocEnd))(view);
      return (blockOn ? (up ? selectPageUp : selectPageDown) : (up ? cursorPageUp : cursorPageDown))(view);
    } else if (e.key !== "Shift") homeCount = 0;
  }

  if (blockOn && inEditor && !e.shiftKey && !e.altKey && BLOCK_NAV[e.key]) {
    e.preventDefault();
    return BLOCK_NAV[e.key][e.ctrlKey || e.metaKey ? 1 : 0](view);
  }
  if (blockOn && e.key === "Escape") { e.preventDefault(); return toggleBlock(false); }

  const cmd = (settings.wpKeys && WPKEYS[c]) || MODERN[c];
  if (cmd) { e.preventDefault(); e.stopPropagation(); run(cmd); }
}
window.addEventListener("keydown", onKey, true);

/* ------------------------------------------------------------------- menu */

const MENUS = [
  { label: "File", items: [["New", "new"], ["Retrieve…", "open"], ["Save", "save"], ["Save as…", "saveAs"], ["Share…", "share"], ["Print", "print"], ["Exit", "exit"]] },
  { label: "Edit", items: [["Undo", "undo"], ["Redo", "redo"], ["Cut", "cut"], ["Copy", "copy"], ["Paste", "paste"], ["Block", "block"], ["Select all", "selectAll"], ["Reveal codes", "reveal"]] },
  { label: "Search", items: [["Find…", "find"], ["Replace…", "replace"]] },
  { label: "Font", items: [["Bold", "bold"], ["Italic", "italic"], ["Underline", "underline"], ["Heading 1", "h1"], ["Heading 2", "h2"], ["Heading 3", "h3"], ["Normal text", "h0"]] },
  { label: "Tools", items: [["Word count", "count"], ["Spell check", "spell"]] },
  { label: "Setup", items: [["Setup…", "setup"]] },
  { label: "Help", items: [["Keyboard", "help"], ["About Impeccable", "about"]] },
];
let mi = 0, di = 0;

function openMenu() { mi = 0; di = 0; renderMenu(); }
function closeMenu() { menubar.hidden = true; dropEl.hidden = true; view.focus(); }

function renderMenu() {
  menubar.hidden = false;
  menubar.innerHTML = MENUS.map((m, i) =>
    `<button class="mi${i === mi ? " on" : ""}" data-i="${i}" tabindex="-1"><span class="hot">${m.label[0]}</span>${esc(m.label.slice(1))}</button>`).join("");
  const m = MENUS[mi];
  dropEl.innerHTML = m.items.map(([label, cmd], j) =>
    `<button class="di${j === di ? " on" : ""}" data-j="${j}" tabindex="-1"><span>${esc(label)}</span><span class="sc">${esc(shortcutFor(cmd))}</span></button>`).join("");
  dropEl.hidden = false;
  const anchor = menubar.children[mi];
  const maxLeft = window.innerWidth - dropEl.offsetWidth - 4;
  dropEl.style.left = Math.max(0, Math.min(anchor.offsetLeft, maxLeft)) + "px";
  dropEl.style.top = menubar.offsetTop + menubar.offsetHeight + "px";
}

function menuRun(j) { const cmd = MENUS[mi].items[j][1]; closeMenu(); run(cmd); }

function menuKey(e) {
  e.preventDefault(); e.stopPropagation();
  const n = MENUS.length, items = MENUS[mi].items.length;
  if (e.key === "ArrowLeft") { mi = (mi + n - 1) % n; di = 0; }
  else if (e.key === "ArrowRight") { mi = (mi + 1) % n; di = 0; }
  else if (e.key === "ArrowUp") di = (di + items - 1) % items;
  else if (e.key === "ArrowDown") di = (di + 1) % items;
  else if (e.key === "Enter" || e.key === " ") return menuRun(di);
  else if (e.key === "Escape" || e.key === "F1" || comboOf(e) === "A-equal" || e.key === "F7") return closeMenu();
  else if (e.key.length === 1) {
    const i = MENUS.findIndex((m) => m.label[0].toLowerCase() === e.key.toLowerCase());
    if (i >= 0) { mi = i; di = 0; }
  }
  renderMenu();
}

menubar.addEventListener("click", (e) => { const b = e.target.closest(".mi"); if (b) { mi = +b.dataset.i; di = 0; renderMenu(); } });
dropEl.addEventListener("click", (e) => { const b = e.target.closest(".di"); if (b) menuRun(+b.dataset.j); });
for (const el of [menubar, dropEl]) el.addEventListener("pointerdown", (e) => e.preventDefault());
document.addEventListener("pointerdown", (e) => {
  if (!menubar.hidden && !menubar.contains(e.target) && !dropEl.contains(e.target)) closeMenu();
});

/* ------------------------------------------------- keyboard template strip */

// Colour-coded like the cardboard template: black plain, green Shift, blue Alt, red Ctrl.
const TEMPLATE = [
  ["menu", "Menu", "Alt+="], ["save", "Save", "F10"], ["open", "Retrieve", "Shift+F10"],
  ["bold", "Bold", "F6"], ["italic", "Italic", "Ctrl+F8"], ["underline", "Undrln", "F8"],
  ["reveal", "Codes", "Alt+F3"], ["find", "Search", "F2"], ["undo", "Undo", "Ctrl+Z"],
  ["block", "Block", "Alt+F4"], ["count", "Count", "Tools"], ["help", "Help", "F3"],
];
templateEl.innerHTML = TEMPLATE.map(([cmd, label, key]) => {
  const mod = /^Ctrl/.test(key) ? "ctrl" : /^Shift/.test(key) ? "shift" : /^Alt/.test(key) ? "alt" : "plain";
  return `<button class="key ${mod}" data-cmd="${cmd}"><span class="k">${esc(key)}</span><span>${esc(label)}</span></button>`;
}).join("");
templateEl.addEventListener("pointerdown", (e) => { if (e.target.closest(".key")) e.preventDefault(); });
templateEl.addEventListener("click", (e) => { const b = e.target.closest(".key"); if (b) run(b.dataset.cmd); });

/* --------------------------------------------------- full-screen pages */

function openScreen(html, onKey) {
  screenEl.innerHTML = html;
  screenEl.hidden = false;
  screenEl.scrollTop = 0;
  screenKey = onKey;
}
function closeScreen() { screenEl.hidden = true; screenEl.innerHTML = ""; screenKey = null; view.focus(); }

const SETUP_ROWS = [
  ["wpKeys", "WordPerfect 5.1 keys"],
  ["col80", "80-column page"],
  ["size", "Text size"],
  ["template", "Keyboard template"],
  ["spell", "Spell check"],
  ["cursor", "Cursor"],
];
const showValue = (v) => (typeof v === "boolean" ? (v ? "Yes" : "No") : v[0].toUpperCase() + v.slice(1));

function cycleSetting(k) {
  if (typeof settings[k] === "boolean") settings[k] = !settings[k];
  else { const c = CHOICES[k]; settings[k] = c[(c.indexOf(settings[k]) + 1) % c.length]; }
  saveSettings();
}

function showSetup() {
  const render = () => openScreen(
    `<h1>Setup</h1>
     <div class="rows">${SETUP_ROWS.map(([k, label], i) =>
       `<button class="row" data-k="${k}"><span class="n">${i + 1}</span> - <span class="l">${esc(label)}</span><span class="v">${showValue(settings[k])}</span></button>`).join("")}
     </div>
     <p class="sel">Selection: <button class="row exit">0</button></p>
     <p class="note">Press a number to change it, 0 or Esc to return. Some browsers keep F5, F11, F12 and Alt+F4 for themselves; installing Impeccable as an app frees most of them.</p>`, setupKey);
  const setupKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= SETUP_ROWS.length) { cycleSetting(SETUP_ROWS[n - 1][0]); render(); }
    else if (["0", "Escape", "Enter", "F1", "F7"].includes(e.key)) closeScreen();
  };
  render();
  screenEl.onclick = (e) => {
    const b = e.target.closest(".row"); if (!b) return;
    if (b.classList.contains("exit")) return closeScreen();
    cycleSetting(b.dataset.k); render();
  };
}

function keyList(map, extra = []) {
  const names = {
    save: "Save", saveAs: "Save as", open: "Retrieve", new: "New document", print: "Print",
    bold: "Bold", italic: "Italic", underline: "Underline", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h0: "Normal text",
    find: "Search", replace: "Replace", reveal: "Reveal codes", setup: "Setup", menu: "Menu bar", help: "Help",
    cancel: "Cancel", exit: "Exit", spell: "Spell check on/off", block: "Block",
  };
  const rows = Object.entries(map).map(([k, c]) => [keyLabel(k), names[c] || c]).concat(extra);
  return `<div class="keys">${rows.map(([k, v]) => `<div><span class="kk">${esc(k)}</span>${esc(v)}</div>`).join("")}</div>`;
}

function showHelp() {
  openScreen(
    `<h1>Impeccable 5.2 Help</h1>
     <h2>Everyday keys</h2>
     ${keyList(MODERN, [["Ctrl+Z / Y", "Undo / redo"], ["Ctrl+X C V", "Cut, copy, paste"], ["Shift+arrows", "Block text"]])}
     <h2>WordPerfect 5.1 keys${settings.wpKeys ? "" : " (turn on in Setup)"}</h2>
     ${keyList(WPKEYS, [["Home Home ↑ ↓", "Top or bottom of document"], ["Home ← →", "Start or end of line"]])}
     <h2>How it saves</h2>
     <p>Documents are plain Markdown (.md). Bold is <b>**text**</b>, italic is <b>_text_</b>, underline is <b>&lt;u&gt;text&lt;/u&gt;</b> and headings start with <b>#</b>. Reveal codes shows the markup. Your work is kept in this browser as you type, so a closed tab loses nothing, but use Save to keep a real file.</p>
     <p class="sel"><button class="row exit">Press any key to continue</button></p>`,
    (e) => { e.preventDefault(); e.stopPropagation(); if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) closeScreen(); });
  screenEl.onclick = (e) => { if (e.target.closest(".exit")) closeScreen(); };
}

function showAbout() {
  openScreen(
    `<h1>Impeccable 5.2</h1>
     <p class="tag">Write flawlessly.</p>
     <p>A distraction-free Markdown word processor in the spirit of WordPerfect 5.1 for DOS. Version ${VERSION}.</p>
     <p>Open source under the MIT licence. Built with CodeMirror and marked; set in VT323 under the SIL Open Font License.</p>
     <p>Not affiliated with Corel Corporation. WordPerfect is a trademark of Corel.</p>
     <p class="sel"><button class="row exit">Press any key to continue</button></p>`,
    (e) => { e.preventDefault(); e.stopPropagation(); if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) closeScreen(); });
  screenEl.onclick = (e) => { if (e.target.closest(".exit")) closeScreen(); };
}

/* ---------------------------------------------------------- apply settings */

const coarse = matchMedia("(pointer: coarse)");
function applySettings() {
  document.documentElement.dataset.size = settings.size;
  document.body.classList.toggle("col80", settings.col80);
  document.body.classList.toggle("cursor-bar", settings.cursor === "bar");
  templateEl.hidden = !(settings.template === "on" || (settings.template === "auto" && coarse.matches));
  view.dispatch({ effects: spellComp.reconfigure(spellExt()) });
  updateStatus();
}
function saveSettings() { store.set("settings", settings); applySettings(); }
coarse.addEventListener?.("change", applySettings);

/* ------------------------------------------------------------------- start */

applySettings();
view.focus();
msg(templateEl.hidden ? `${settings.wpKeys ? "F3" : "F1"} help, Alt+= menu` : "Help is on the strip below", 6000);

idb.get("handle").then((h) => { if (h && !docState.handle) docState.handle = h; });

// Installed on desktop, .md files can open straight into Impeccable.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (p) => {
    if (!p.files?.length) return;
    if (await confirmDiscard()) await loadHandle(p.files[0]);
  });
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
