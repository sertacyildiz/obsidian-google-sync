/* Minimal mock of the Obsidian plugin API — just enough to RUN the plugin's
 * load path (onload + settings tab + commands) headlessly in Node. Aliased in
 * place of the real `obsidian` module by the smoke test. Not shipped. */
export class App {}
export class Notice {
  constructor(_msg: string) {}
}
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T): T {
  return fn;
}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}
export async function requestUrl(_o: unknown): Promise<unknown> {
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
  return { empty() {}, createEl() { return makeEl(); }, createDiv() { return makeEl(); }, setText() {}, appendChild() {}, appendText() {} };
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
  async loadData() { return this._data; }
  async saveData(d: unknown) { this._data = d; }
  async onload() {}
  onunload() {}
}

export interface TFile {
  path: string;
}

/** Type-only aliases so the plugin's `import type` names resolve against the mock. */
export type SettingDefinitionItem = MockSettingDefinition;
export type SettingDefinitionRender = MockSettingDefinition;
