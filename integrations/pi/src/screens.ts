import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from '@earendil-works/pi-tui';
import { candidates, split, type PathBase, type PathEntry } from './paths.ts';

/*
 * The panel's screens. The panel shows one at a time, on a stack: the settings list, a list of choices, a text prompt or
 * a path picker. Escape and ctrl+s belong to the panel; a screen receives every other key.
 */
/** The parts of Pi's theme the panel uses. */
export interface PanelTheme { fg(color: ThemeColor, text: string): string; bold(text: string): string }
/** What a screen may ask of the panel that shows it. */
export interface PanelControl {
  readonly theme: PanelTheme;
  readonly keybindings: KeybindingsManager;
  push(screen: Screen): void;
  /** Returns to the screen below this one. */
  pop(): void;
  /** Shows a one-line message until the next key. */
  say(text: string, kind: 'info' | 'error'): void;
}
export interface Screen {
  readonly title: string;
  /** Key hints for the footer, before the panel's own. */
  hints(): string;
  render(width: number): string[];
  handleInput(data: string): Promise<void> | void;
  focused: boolean;
}
/** A row of a list screen. Enter runs `activate`; `p` runs `pin` and delete or backspace runs `remove`, when the row has them. */
export interface ListRow {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  /** A value the row inherits rather than holds, shown dimmed. */
  readonly inherited?: boolean;
  readonly description?: string;
  /** The heading of the group this row starts. */
  readonly section?: string;
  readonly activate?: (() => Promise<void> | void) | undefined;
  readonly pin?: (() => void) | undefined;
  /** What delete does to this row, named in the key hints. */
  readonly remove?: { readonly label: string; run(): void } | undefined;
}
const maxVisible = 14;
/** A list's rows as rebuilt for this render or key, and the row under the cursor. */
interface ListPosition { readonly rows: readonly ListRow[]; readonly row: ListRow | undefined }
const cursor = '→ ';

/** Inserts `text` into an empty input, which leaves the cursor at its end. */
export function setText(input: Input, text: string): void {
  input.setValue('');
  input.handleInput(text);
}

/** A list whose rows are rebuilt on every render; the cursor stays on the row with the same id. */
export class ListScreen implements Screen {
  focused = false;
  readonly title: string;
  private readonly panel: PanelControl;
  private readonly rows: () => readonly ListRow[];
  /** What enter does, named in the key hints. */
  private readonly enter: string;
  private index = 0;
  private selectedId: string | null = null;
  constructor(title: string, panel: PanelControl, enter: string, rows: () => readonly ListRow[]) {
    this.title = title;
    this.panel = panel;
    this.enter = enter;
    this.rows = rows;
  }

  /** Puts the cursor on the row with `id`. */
  select(id: string): this { this.selectedId = id; return this; }

  private current(): ListPosition {
    const rows = this.rows(), found = rows.findIndex(row => row.id === this.selectedId);
    this.index = found === -1 ? Math.min(this.index, rows.length - 1) : found;
    const row = rows[this.index];
    this.selectedId = row?.id ?? null;
    return { rows, row };
  }

  hints(): string {
    const row = this.current().row;
    return ['↑↓ move', row?.activate && `enter ${this.enter}`, row?.pin && 'p pin', row?.remove && `del ${row.remove.label}`].filter(Boolean).join(' · ');
  }

  render(width: number): string[] {
    const { theme } = this.panel, { rows, row: selected } = this.current();
    const labelWidth = Math.min(24, Math.max(0, ...rows.map(row => visibleWidth(row.label))));
    const start = Math.max(0, Math.min(this.index - Math.floor(maxVisible / 2), rows.length - maxVisible));
    const lines: string[] = [];
    for (const [offset, row] of rows.slice(start, start + maxVisible).entries()) {
      if (row.section) lines.push('', theme.fg('muted', theme.bold(row.section)));
      const chosen = start + offset === this.index, label = row.label.padEnd(labelWidth + row.label.length - visibleWidth(row.label));
      const value = row.value === undefined ? '' : `  ${row.inherited ? theme.fg('dim', row.value) : row.value}`;
      lines.push(truncateToWidth((chosen ? theme.fg('accent', cursor + label) : `  ${label}`) + value, width));
    }
    if (rows.length > maxVisible) lines.push(theme.fg('dim', `  (${this.index + 1}/${rows.length})`));
    if (selected?.description) lines.push('', ...wrapTextWithAnsi(selected.description, width - 2).map(line => theme.fg('muted', `  ${line}`)));
    return lines;
  }

  async handleInput(data: string): Promise<void> {
    const { rows, row } = this.current(), kb = this.panel.keybindings;
    if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
      const step = kb.matches(data, 'tui.select.up') ? -1 : 1;
      this.selectedId = rows[(this.index + step + rows.length) % rows.length]?.id ?? null;
    }
    else if (kb.matches(data, 'tui.select.confirm')) await row?.activate?.();
    else if (data === 'p') row?.pin?.();
    else if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) row?.remove?.run();
  }
}

/** A row of a filtered list; enter runs `activate`. */
export interface FilterRow { readonly id: string; readonly label: string; readonly value?: string; readonly description?: string; activate(): void }

/** A list narrowed by typed text, matched fuzzily against each row's label, as Pi's model selector does. */
export class FilterListScreen implements Screen {
  readonly title: string;
  private readonly input = new Input();
  private readonly panel: PanelControl;
  private readonly enter: string;
  private readonly rows: () => readonly FilterRow[];
  private index = 0;
  constructor(title: string, panel: PanelControl, enter: string, rows: () => readonly FilterRow[]) {
    this.title = title;
    this.panel = panel;
    this.enter = enter;
    this.rows = rows;
  }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  private shown(): FilterRow[] { return fuzzyFilter([...this.rows()], this.input.getValue(), row => row.label); }
  hints(): string { return `type to filter · ↑↓ move · enter ${this.enter}`; }

  render(width: number): string[] {
    const { theme } = this.panel, rows = this.shown(), lines = [...this.input.render(width), ''];
    this.index = Math.min(this.index, Math.max(0, rows.length - 1));
    const labelWidth = Math.min(40, Math.max(0, ...rows.map(row => visibleWidth(row.label))));
    const start = Math.max(0, Math.min(this.index - Math.floor(maxVisible / 2), rows.length - maxVisible));
    for (const [offset, row] of rows.slice(start, start + maxVisible).entries()) {
      const label = row.label.padEnd(labelWidth + row.label.length - visibleWidth(row.label));
      const value = row.value ? `  ${theme.fg('dim', row.value)}` : '';
      lines.push(truncateToWidth((start + offset === this.index ? theme.fg('accent', cursor + label) : `  ${label}`) + value, width));
    }
    if (!rows.length) lines.push(theme.fg('dim', '  nothing matches'));
    else if (rows.length > maxVisible) lines.push(theme.fg('dim', `  (${this.index + 1}/${rows.length})`));
    const description = rows[this.index]?.description;
    return description ? [...lines, '', ...wrapTextWithAnsi(description, width - 2).map(line => theme.fg('muted', `  ${line}`))] : lines;
  }

  handleInput(data: string): void {
    const kb = this.panel.keybindings, rows = this.shown();
    if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
      const step = kb.matches(data, 'tui.select.up') ? -1 : 1;
      this.index = rows.length ? (this.index + step + rows.length) % rows.length : 0;
    }
    else if (kb.matches(data, 'tui.select.confirm')) rows[this.index]?.activate();
    else { this.input.handleInput(data); this.index = 0; }
  }
}

/** A one-line text prompt; `submit` returns a problem to show, or null when it accepted the text. */
export class PromptScreen implements Screen {
  readonly title: string;
  private readonly input = new Input();
  private readonly panel: PanelControl;
  private readonly help: string;
  private readonly submit: (text: string) => string | null;
  constructor(title: string, panel: PanelControl, start: string, help: string, submit: (text: string) => string | null) {
    this.title = title;
    this.panel = panel;
    this.help = help;
    this.submit = submit;
    setText(this.input, start);
  }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  hints(): string { return 'enter accept'; }
  render(width: number): string[] {
    return [...this.input.render(width), '', ...wrapTextWithAnsi(this.help, width - 2).map(line => this.panel.theme.fg('muted', `  ${line}`))];
  }
  handleInput(data: string): void {
    if (!this.panel.keybindings.matches(data, 'tui.input.submit')) { this.input.handleInput(data); return; }
    const problem = this.submit(this.input.getValue().trim());
    if (problem === null) this.panel.pop();
    else this.panel.say(problem, 'error');
  }
}

/** What the picker offers for the typed text itself, ahead of the completions. */
export interface PathTarget { readonly label: string; choose(): Promise<string | null> | string | null }
export interface PathPickerOptions {
  readonly base: PathBase;
  readonly include: 'folders' | 'all';
  /** Whether a leading `!` marks the typed path; completion then works on the text after it. */
  readonly negatable: boolean;
  readonly start: string;
  readonly help: string;
  /** The row for the typed text, or null when it names nothing this picker accepts. */
  target(text: string): PathTarget | null;
  /** Chooses a completion, typed after a leading `!` when `negated`; returns a problem to show, or null when it accepted it. */
  chooseEntry(entry: PathEntry, negated: boolean): Promise<string | null> | string | null;
}
/** Typed text split into its leading `!`, when the picker accepts one, and the path after it. */
interface TypedText { readonly marker: string; readonly path: string }
type PathRow = { readonly kind: 'target'; readonly target: PathTarget } | { readonly kind: 'entry'; readonly entry: PathEntry };

/**
 * A path typed with completion. The list holds the typed path itself when the picker accepts it, then the matching
 * entries of the folder being typed, best first. Tab completes to the highlighted entry, shift+tab goes up one folder,
 * and enter chooses the highlighted row. While a name is partly typed, the best match is highlighted.
 */
export class PathScreen implements Screen {
  readonly title: string;
  private readonly input = new Input();
  private readonly panel: PanelControl;
  private readonly options: PathPickerOptions;
  private rows: PathRow[] = [];
  private index = 0;
  constructor(title: string, panel: PanelControl, options: PathPickerOptions) {
    this.title = title;
    this.panel = panel;
    this.options = options;
    setText(this.input, options.start);
    this.refresh();
  }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private typed(): TypedText {
    const text = this.input.getValue(), marker = this.options.negatable && text.startsWith('!') ? '!' : '';
    return { marker, path: text.slice(marker.length) };
  }

  private refresh(): void {
    const text = this.input.getValue(), { folder, partial } = split(this.typed().path, this.options.base);
    const target = text ? this.options.target(text) : null;
    const entries = candidates(folder, partial, this.options.include).map(entry => ({ kind: 'entry' as const, entry }));
    this.rows = target ? [{ kind: 'target', target }, ...entries] : entries;
    this.index = target && partial && entries.length ? 1 : 0;
  }

  /** Replaces the partly typed name with `entry`, keeping how the user wrote the folders before it. */
  private complete(entry: PathEntry): void {
    const { marker, path } = this.typed(), prefix = path === '~' ? '~/' : path.slice(0, path.lastIndexOf('/') + 1);
    setText(this.input, marker + prefix + entry.name + (entry.folder ? '/' : ''));
    this.refresh();
  }

  hints(): string { return '↑↓ move · tab complete · shift+tab up a folder · enter choose'; }

  render(width: number): string[] {
    const { theme } = this.panel, lines = [...this.input.render(width), ''];
    const start = Math.max(0, Math.min(this.index - Math.floor(maxVisible / 2), this.rows.length - maxVisible));
    for (const [offset, row] of this.rows.slice(start, start + maxVisible).entries()) {
      const text = row.kind === 'target' ? row.target.label : row.entry.name + (row.entry.folder ? '/' : '');
      const styled = row.kind === 'target' ? theme.bold(text) : row.entry.folder ? theme.fg('accent', text) : text;
      lines.push(truncateToWidth(start + offset === this.index ? theme.fg('accent', cursor) + styled : `  ${styled}`, width));
    }
    if (!this.rows.length) lines.push(theme.fg('dim', '  nothing matches here'));
    return [...lines, '', ...wrapTextWithAnsi(this.options.help, width - 2).map(line => theme.fg('muted', `  ${line}`))];
  }

  async handleInput(data: string): Promise<void> {
    const kb = this.panel.keybindings;
    if (kb.matches(data, 'tui.select.up')) this.move(-1);
    else if (kb.matches(data, 'tui.select.down')) this.move(1);
    else if (matchesKey(data, Key.shift('tab'))) this.up();
    else if (matchesKey(data, Key.tab)) this.tab();
    else if (kb.matches(data, 'tui.select.confirm')) await this.choose();
    else { this.input.handleInput(data); this.refresh(); }
  }

  private move(step: number): void {
    this.index = this.rows.length ? (this.index + step + this.rows.length) % this.rows.length : 0;
  }

  /** Removes the last folder from the typed path. */
  private up(): void {
    const { marker, path } = this.typed(), trimmed = path.replace(/\/+$/, '');
    setText(this.input, marker + trimmed.slice(0, trimmed.lastIndexOf('/') + 1));
    this.refresh();
  }

  /** Completes to the highlighted entry; on the typed path's own row, enters that folder. */
  private tab(): void {
    const row = this.rows[this.index], text = this.input.getValue();
    if (row?.kind === 'entry') this.complete(row.entry);
    else if (row?.kind === 'target' && !text.endsWith('/')) { setText(this.input, `${text}/`); this.refresh(); }
  }

  private async choose(): Promise<void> {
    const row = this.rows[this.index];
    if (!row) { this.panel.say('Type a path first.', 'error'); return; }
    const problem = await (row.kind === 'target' ? row.target.choose() : this.options.chooseEntry(row.entry, this.typed().marker === '!'));
    if (problem === null) this.panel.pop();
    else this.panel.say(problem, 'error');
  }
}
