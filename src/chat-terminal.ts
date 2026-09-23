import { createInterface, type Interface } from "node:readline/promises";
import type { Project } from "./registry.js";
import { commandCompletions } from "./chat-commands.js";
import { terminalSafe } from "./terminal.js";

export interface ChatTerminal {
  write(text: string): void;
  status(text: string): void;
  read(prompt: string, fresh?: boolean, signal?: AbortSignal): Promise<string | null>;
  onCancel: (() => void) | undefined;
  close(): void;
  suspend<T>(work: () => Promise<T>): Promise<T>;
}

export class PlainTerminal implements ChatTerminal {
  onCancel: (() => void) | undefined;
  private input: Interface;
  private queue: string[] = [];
  private waiting: ((line: string | null) => void) | undefined;
  private closed = false;
  private fresh = false;
  private multiline: string[] | undefined;

  constructor(project: Project) {
    this.input = createInterface({ input: process.stdin, output: process.stderr, terminal: true,
      completer: (line: string) => commandCompletions(project, line) });
    this.input.on("line", (line) => {
      if (!this.fresh && line === "/paste" && !this.multiline) {
        this.multiline = [];
        process.stderr.write("Paste mode: enter /end on its own line to submit.\n");
        return;
      }
      if (this.multiline) {
        if (line !== "/end") {
          if (this.multiline.join("\n").length + line.length > 48_000) {
            this.multiline = undefined; this.status("Paste discarded: input exceeds 48000 characters");
          } else this.multiline.push(line);
          return;
        }
        line = this.multiline.join("\n");
        this.multiline = undefined;
      }
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else if (!this.fresh) {
        if (this.queue.length >= 20 || line.length > 48_000) { this.status("Input queue limit reached; message discarded"); return; }
        this.queue.push(line);
        this.status("message queued; Ctrl-C cancels the current turn");
      }
    });
    this.input.on("SIGINT", () => this.onCancel?.());
    this.input.on("close", () => { this.closed = true; this.waiting?.(null); this.waiting = undefined; this.onCancel?.(); });
  }

  write(text: string): void { process.stdout.write(terminalSafe(text)); }
  status(text: string): void { process.stderr.write(terminalSafe(`\n[${text}]\n`)); }

  async read(prompt: string, fresh = false, signal?: AbortSignal): Promise<string | null> {
    if (this.closed || signal?.aborted) return null;
    if (!fresh && this.queue.length) return this.queue.shift()!;
    this.fresh = fresh;
    if (fresh) {
      this.multiline = undefined;
      this.input.write(null, { ctrl: true, name: "u" });
    }
    const abort = (): void => { this.waiting?.(null); this.waiting = undefined; };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<string | null>((resolve) => {
        this.waiting = resolve;
        this.input.setPrompt(terminalSafe(prompt));
        this.input.prompt();
      });
    } finally { this.fresh = false; signal?.removeEventListener("abort", abort); }
  }

  async suspend<T>(work: () => Promise<T>): Promise<T> {
    this.fresh = true;
    this.input.pause();
    process.stdin.setRawMode(false);
    try { return await work(); }
    finally { process.stdin.setRawMode(true); this.input.resume(); this.fresh = false; }
  }

  close(): void { this.closed = true; this.input.close(); }
}

export async function fullscreenTerminal(project: Project): Promise<ChatTerminal> {
  const { default: blessed } = await import("blessed");
  const screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: "Jev Code", autoPadding: true });
  const log = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%-9",
    scrollable: true, alwaysScroll: true, mouse: true, tags: false, border: "line", label: " Transcript | PgUp/PgDn scroll " });
  const status = blessed.box({ parent: screen, bottom: 7, height: 1, width: "100%", tags: false });
  const prompt = blessed.box({ parent: screen, bottom: 6, height: 1, width: "100%", tags: false });
  const editor = blessed.box({ parent: screen, bottom: 1, height: 5, width: "100%", border: "line",
    scrollable: true, keys: true, tags: false });
  blessed.box({ parent: screen, bottom: 0, height: 1, width: "100%", tags: false,
    content: "Ctrl-S submit | Enter newline | Tab complete | Ctrl-C cancel/exit | PgUp/PgDn scroll" });
  const menu = blessed.box({ parent: screen, bottom: 6, height: 5, width: "100%", border: "line", hidden: true, tags: false });
  let waiting: ((line: string | null) => void) | undefined;
  let fresh = false;
  let closed = false;
  let suspended = false;
  let text = "";
  let value = "";
  let cursor = 0;
  const queue: string[] = [];
  let renderPending: NodeJS.Timeout | undefined;
  const render = (): void => {
    if (renderPending || closed) return;
    renderPending = setTimeout(() => { renderPending = undefined; if (!closed) screen.render(); }, 16);
  };
  const showEditor = (): void => {
    const characters = Array.from(value);
    const before = characters.slice(0, cursor).join("");
    editor.setContent(`${terminalSafe(before)}\x1b[7m${terminalSafe(characters[cursor] === "\n" ? " " : characters[cursor] ?? " ")}\x1b[27m${terminalSafe(characters.slice(cursor + (characters[cursor] === "\n" ? 0 : 1)).join(""))}`);
    editor.setScroll(Math.max(0, before.split("\n").length - 3));
    render();
  };
  const resetEditor = (): void => { value = ""; cursor = 0; showEditor(); editor.focus(); menu.hide(); };
  const api: ChatTerminal = {
    onCancel: undefined,
    write(value) {
      text = (text + terminalSafe(value)).slice(-120_000);
      const atBottom = log.getScrollPerc() >= 99;
      log.setContent(text);
      if (atBottom) log.setScrollPerc(100);
      render();
    },
    status(value) { status.setContent(terminalSafe(value)); render(); },
    async read(value, requireFresh = false, signal) {
      if (closed || signal?.aborted) return null;
      if (!requireFresh && queue.length) return queue.shift()!;
      fresh = requireFresh;
      if (fresh) {
        resetEditor();
        if (value.length > 100_000) throw new Error("Action exceeds the full-screen review limit; request a smaller action");
        api.write(`\n${value}\n`);
        log.setScrollPerc(100);
      }
      prompt.setContent(terminalSafe(fresh ? value.split("\n").at(-1) ?? "" : value));
      const abort = (): void => { waiting?.(null); waiting = undefined; };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await new Promise<string | null>((resolve) => { waiting = resolve; editor.focus(); render(); });
      } finally { fresh = false; signal?.removeEventListener("abort", abort); }
    },
    async suspend<T>(work: () => Promise<T>): Promise<T> {
      fresh = true;
      suspended = true;
      const resume = screen.program.pause();
      try { return await work(); }
      finally {
        resume();
        suspended = false;
        fresh = false;
        if (closed) screen.destroy();
        else { screen.realloc(); resetEditor(); screen.render(); }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (renderPending) clearTimeout(renderPending);
      waiting?.(null); waiting = undefined;
      if (!suspended) screen.destroy();
    },
  };
  editor.key("C-s", () => {
    if (value.length > 48_000) { api.status("Input exceeds 48000 characters"); return; }
    const submitted = value;
    resetEditor();
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(submitted); }
    else if (!fresh) {
      if (queue.length >= 20) api.status("Input queue full; message discarded");
      else { queue.push(submitted); api.status("message queued; Ctrl-C cancels the current turn"); }
    }
  });
  editor.key("tab", () => {
    const [candidates] = commandCompletions(project, value);
    if (candidates.length === 1) { value = candidates[0]!; cursor = Array.from(value).length; showEditor(); }
    menu.setContent(candidates.slice(0, 10).map(terminalSafe).join("  "));
    if (candidates.length > 1) menu.show(); else menu.hide();
    render();
  });
  editor.on("keypress", (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    const characters = Array.from(value);
    if (key.ctrl || key.meta) {
      if (key.ctrl && key.name === "u") { value = ""; cursor = 0; showEditor(); }
      return;
    }
    if (key.name === "left") cursor = Math.max(0, cursor - 1);
    else if (key.name === "right") cursor = Math.min(characters.length, cursor + 1);
    else if (key.name === "up" || key.name === "down") {
      const start = characters.slice(0, cursor).lastIndexOf("\n") + 1;
      const column = cursor - start;
      if (key.name === "up" && start > 0) {
        const previousStart = characters.slice(0, start - 1).lastIndexOf("\n") + 1;
        cursor = Math.min(start - 1, previousStart + column);
      } else if (key.name === "down") {
        const next = characters.indexOf("\n", cursor);
        if (next >= 0) {
          const end = characters.indexOf("\n", next + 1);
          cursor = Math.min(end < 0 ? characters.length : end, next + 1 + column);
        }
      }
    }
    else if (key.name === "home") cursor = Math.max(0, characters.slice(0, cursor).lastIndexOf("\n") + 1);
    else if (key.name === "end") {
      const end = characters.indexOf("\n", cursor);
      cursor = end < 0 ? characters.length : end;
    } else if (key.name === "backspace") { if (cursor) characters.splice(--cursor, 1); }
    else if (key.name === "delete") characters.splice(cursor, 1);
    else if (key.name === "enter" || (character && !/[\x00-\x1f\x7f]/.test(character))) {
      const inserted = key.name === "enter" ? "\n" : character!;
      if (value.length + inserted.length > 48_000) { api.status("Input limit reached (48000 characters)"); return; }
      characters.splice(cursor, 0, ...Array.from(inserted));
      cursor += Array.from(inserted).length;
    } else return;
    value = characters.join("");
    menu.hide();
    showEditor();
  });
  screen.key(["pageup", "pagedown"], (_character, key) => {
    log.scroll(key.name === "pageup" ? -10 : 10); render();
  });
  screen.key("C-c", () => api.onCancel?.());
  screen.on("resize", render);
  screen.on("destroy", () => { waiting?.(null); waiting = undefined; });
  editor.focus();
  screen.render();
  return api;
}
