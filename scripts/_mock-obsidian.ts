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
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addText(cb: (c: Component) => void) { cb(new Component()); return this; }
  addToggle(cb: (c: Component) => void) { cb(new Component()); return this; }
  addDropdown(cb: (c: Component) => void) { cb(new Component()); return this; }
  addButton(cb: (c: Component) => void) { cb(new Component()); return this; }
}

function makeEl(): Record<string, unknown> {
  return { empty() {}, createEl() { return makeEl(); }, createDiv() { return makeEl(); }, setText() {}, appendChild() {} };
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: unknown;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
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
