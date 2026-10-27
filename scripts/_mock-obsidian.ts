/* Minimal mock of the Obsidian plugin API — just enough to RUN the plugin's
 * load path (onload + settings tab + commands) headlessly in Node. Aliased in
 * place of the real `obsidian` module by the smoke test. Not shipped. */
export class App {}
/** Every notice shown, oldest first. */
export const notices: string[] = [];
export class Notice {
  constructor(msg: string) {
    notices.push(msg);
  }
}
/** Text that settings fragments rendered (createEl `text`, appendText, setText) — lets a test read the copy. */
export const renderedText: string[] = [];
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T): T {
  return fn;
}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}
/** Platform flags — mutable so a test can pose as the mobile app. Defaults to desktop. */
export const Platform = { isDesktopApp: true, isMobileApp: false, isMobile: false };

/** Every request handed to `requestUrl`, oldest first — lets transport tests see exactly what reached Obsidian. */
export const requestUrlCalls: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }[] = [];

/**
 * Desktop `requestUrl` passes the request to Electron's `net.request`, and its
 * network service fails any request that sets a header the HTTP stack owns —
 * before anything is sent. Reproduced against Electron 39.7.0 (the runtime of
 * Obsidian 1.13.7): `host` alone, or `content-length` alone, is enough. The mock
 * enforces the same rule so a transport that leaks one fails here, not in the app.
 */
const STACK_OWNED = new Set(["host", "content-length"]);

export async function requestUrl(o: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }): Promise<unknown> {
  requestUrlCalls.push(o);
  for (const name of Object.keys(o.headers ?? {})) {
    if (STACK_OWNED.has(name.toLowerCase())) throw new Error("net::ERR_INVALID_ARGUMENT");
  }
  return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "" };
}

class Component {
  inputEl: { type: string } = { type: "text" };
  setValue() { return this; }
  setPlaceholder() { return this; }
  setButtonText() { return this; }
  setCta() { return this; }
  addOption() { return this; }
  onChange() { return this; }
  onClick() { return this; }
  setDisabled() { return this; }
  setWarning() { return this; }
  setDestructive() { return this; }
}

export class Setting {
  constructor(_containerEl?: unknown) {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addText(cb: (c: Component) => void) { cb(new Component()); return this; }
  addToggle(cb: (c: Component) => void) { cb(new Component()); return this; }
  addDropdown(cb: (c: Component) => void) { cb(new Component()); return this; }
  addButton(cb: (c: Component) => void) { cb(new Component()); return this; }
}

export class SettingGroup {}

function makeEl(): Record<string, unknown> {
  return {
    empty() {},
    createEl(_tag?: string, o?: { text?: string }) {
      if (o?.text) renderedText.push(o.text);
      return makeEl();
    },
    createDiv() { return makeEl(); },
    setText(t?: string) { if (t) renderedText.push(t); },
    appendChild() {},
    appendText(t?: string) { if (t) renderedText.push(t); },
  };
}

/**
 * `createFragment` is an Obsidian *global*, not a module export — plugin code
 * calls it unqualified, so it has to exist on globalThis for the headless run.
 * Installed as a module side effect so every test that aliases `obsidian` to
 * this mock gets it.
 */
(globalThis as unknown as { createFragment: (cb?: (el: unknown) => void) => unknown }).createFragment = (cb) => {
  const frag = makeEl();
  if (cb) cb(frag);
  return frag;
};

/** A setting definition as the declarative API shapes it (only what tests touch). */
export interface MockSettingDefinition {
  name?: string;
  desc?: unknown;
  heading?: string;
  type?: string;
  visible?: boolean | (() => boolean);
  control?: { type: string; key: string };
  action?: (index: number) => void;
  render?: (setting: Setting, group: SettingGroup) => void | (() => void);
  items?: MockSettingDefinition[];
}

export class PluginSettingTab {
  app: unknown;
  plugin: { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> };
  containerEl: unknown;
  settingItems: MockSettingDefinition[] = [];
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin as PluginSettingTab["plugin"];
    this.containerEl = makeEl();
  }
  /** Overridden by plugins on 1.13+; the base returns nothing. */
  getSettingDefinitions(): MockSettingDefinition[] {
    return [];
  }
  /** Real Obsidian reads from `plugin.settings`; mirror that so unoverridden keys work. */
  getControlValue(key: string): unknown {
    return this.plugin.settings?.[key];
  }
  setControlValue(key: string, value: unknown): void | Promise<void> {
    if (this.plugin.settings) this.plugin.settings[key] = value;
  }
  update(): void {
    this.settingItems = this.getSettingDefinitions();
  }
  display() {}
  hide() {}
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  _commands: { id: string }[] = [];
  _ribbons: unknown[] = [];
  _settingTabs: { display: () => void }[] = [];
  _events: unknown[] = [];
  _intervals: unknown[] = [];
  _protocolHandlers: { action: string; handler: (params: Record<string, string>) => unknown }[] = [];
  _domEvents: { el: unknown; type: string; cb: () => unknown }[] = [];
  private _data: unknown = null;
  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
  addRibbonIcon(_icon: string, _title: string, cb: unknown) { this._ribbons.push(cb); return makeEl(); }
  addCommand(cmd: { id: string }) { this._commands.push(cmd); return cmd; }
  addSettingTab(tab: { display: () => void }) { this._settingTabs.push(tab); }
  registerEvent(ref: unknown) { this._events.push(ref); }
  registerInterval(id: unknown) { this._intervals.push(id); return id; }
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown) { this._protocolHandlers.push({ action, handler }); }
  registerDomEvent(el: unknown, type: string, cb: () => unknown) { this._domEvents.push({ el, type, cb }); }
  async loadData() { return this._data; }
  async saveData(d: unknown) { this._data = d; }
  async onload() {}
  onunload() {}
}

/**
 * Real classes, not interfaces: the store narrows with `instanceof TFile` /
 * `instanceof TFolder` (Obsidian's documented idiom), so the offline tests have
 * to construct genuine instances for that narrowing to behave as it does in the app.
 */
export class TAbstractFile {
  path = "";
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; ctime: number; size: number } = { mtime: 0, ctime: 0, size: 0 };
  basename = "";
  extension = "";

  constructor(path?: string, mtime = 1) {
    super();
    if (path !== undefined) {
      this.path = path;
      const base = path.slice(path.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      this.basename = dot === -1 ? base : base.slice(0, dot);
      this.extension = dot === -1 ? "" : base.slice(dot + 1);
    }
    this.stat.mtime = mtime;
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  constructor(path?: string) {
    super();
    if (path !== undefined) this.path = path;
  }

  isRoot(): boolean {
    return this.path === "";
  }
}

/** Type-only aliases so the plugin's `import type` names resolve against the mock. */
export type SettingDefinitionItem = MockSettingDefinition;
export type SettingDefinitionRender = MockSettingDefinition;
