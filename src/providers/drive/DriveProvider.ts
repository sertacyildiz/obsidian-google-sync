import { HttpResponse, HttpSend, PutResult, RemoteObject, RemoteProvider } from "../RemoteProvider";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveConfig {
  /** "/"-separated sync root, e.g. "Obsidian Sync/My Vault"; created nested under the Drive root. */
  appFolderName: string;
}

/** Escape a value for use inside a Drive `q` query (single-quote delimited). */
export function escapeDriveQuery(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

/**
 * Drive provider over the Drive API v3 (drive.file scope). The vault's folder
 * structure is **mirrored as real Drive folders** under a per-vault sync root,
 * so the remote layout matches the vault (no flat dump, no path-length cap).
 * A file's path is its folder location + name. Auth is an injected token getter
 * (OAuth Bearer); transport is injected.
 */
export class DriveProvider implements RemoteProvider {
  readonly id = "drive";
  private rootId: string | null = null;
  private readonly folderIds = new Map<string, string>(); // dir ("" = root) -> folder id

  constructor(
    private readonly cfg: DriveConfig,
    private readonly getToken: () => Promise<string>,
    private readonly http: HttpSend
  ) {}

  private async hdrs(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.getToken()}`, ...extra };
  }

  private async json<T>(res: HttpResponse, op: string): Promise<T> {
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive ${op} ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private dirOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }
  private baseOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? path : path.slice(i + 1);
  }

  /** The per-vault sync root id (`appFolderName` resolved as a nested "/"-path). */
  private async root(): Promise<string> {
    if (this.rootId) return this.rootId;
    let parent = "root";
    for (const name of this.cfg.appFolderName.split("/").map((s) => s.trim()).filter(Boolean)) {
      parent = await this.findOrCreateFolder(name, parent);
    }
    this.rootId = parent;
    this.folderIds.set("", parent);
    return parent;
  }

  /** Folder id for a "/"-separated dir under the root; `create=false` → null if missing. */
  private async folderFor(dir: string, create: boolean): Promise<string | null> {
    const cached = this.folderIds.get(dir);
    if (cached) return cached;
    let parent = await this.root();
    let acc = "";
    for (const seg of dir.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      let id = this.folderIds.get(acc);
      if (!id) {
        const found = await this.findFolder(seg, parent);
        id = found ?? (create ? await this.createFolder(seg, parent) : undefined);
        if (!id) return null;
        this.folderIds.set(acc, id);
      }
      parent = id;
    }
    return parent;
  }

  private async findFolder(name: string, parent: string): Promise<string | undefined> {
    const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and '${parent}' in parents and trashed=false`;
    const res = await this.http("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id)")}&spaces=drive`, await this.hdrs());
    return (await this.json<{ files?: DriveFile[] }>(res, "find-folder")).files?.[0]?.id;
  }

  private async createFolder(name: string, parent: string): Promise<string> {
    const meta = JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] });
    const cr = await this.http("POST", `${API}/files?fields=id`, await this.hdrs({ "content-type": "application/json" }), new TextEncoder().encode(meta).buffer);
    return (await this.json<{ id: string }>(cr, "create-folder")).id;
  }

  private async findOrCreateFolder(name: string, parent: string): Promise<string> {
    return (await this.findFolder(name, parent)) ?? (await this.createFolder(name, parent));
  }

  private async locate(path: string): Promise<{ id: string; version: string; size: number } | null> {
    const parent = await this.folderFor(this.dirOf(path), false);
    if (!parent) return null;
    const q = `name='${escapeDriveQuery(this.baseOf(path))}' and '${parent}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
    const res = await this.http("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,md5Checksum,modifiedTime,size)")}&spaces=drive`, await this.hdrs());
    const f = (await this.json<{ files?: DriveFile[] }>(res, "find")).files?.[0];
    return f?.id ? { id: f.id, version: f.md5Checksum ?? f.modifiedTime ?? "", size: Number(f.size ?? 0) } : null;
  }

  async put(path: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<PutResult> {
    let id = (await this.locate(path))?.id;
    if (!id) {
      const parent = (await this.folderFor(this.dirOf(path), true)) as string;
      const meta = JSON.stringify({ name: this.baseOf(path), parents: [parent] });
      const cr = await this.http("POST", `${API}/files?fields=id`, await this.hdrs({ "content-type": "application/json" }), new TextEncoder().encode(meta).buffer);
      id = (await this.json<{ id: string }>(cr, "create")).id;
    }
    const up = await this.http(
      "PATCH",
      `${UPLOAD}/files/${id}?uploadType=media&fields=${encodeURIComponent("md5Checksum,modifiedTime")}`,
      await this.hdrs({ "content-type": contentType }),
      data
    );
    const r = await this.json<DriveFile>(up, "upload");
    return { version: r.md5Checksum ?? r.modifiedTime ?? "" };
  }

  async get(path: string): Promise<ArrayBuffer | null> {
    const f = await this.locate(path);
    if (!f) return null;
    const res = await this.http("GET", `${API}/files/${f.id}?alt=media`, await this.hdrs());
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive GET ${path}: ${res.status}`);
    return res.arrayBuffer();
  }

  async head(path: string): Promise<RemoteObject | null> {
    const f = await this.locate(path);
    return f ? { path, version: f.version, size: f.size } : null;
  }

  async delete(path: string): Promise<void> {
    const f = await this.locate(path);
    if (!f) return;
    const res = await this.http("DELETE", `${API}/files/${f.id}`, await this.hdrs());
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new Error(`Drive DELETE ${path}: ${res.status}`);
  }

  async list(prefix = ""): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    await this.walk(await this.root(), "", out);
    if (!prefix) return out;
    const p = prefix.replace(/\/+$/, "");
    return out.filter((o) => o.path === p || o.path.startsWith(`${p}/`));
  }

  /** Depth-first traversal of the sync root, reconstructing each file's path from the folder chain. */
  private async walk(folderId: string, prefix: string, out: RemoteObject[]): Promise<void> {
    let pageToken: string | undefined;
    do {
      const q = `'${folderId}' in parents and trashed=false`;
      let url =
        `${API}/files?q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)")}` +
        `&pageSize=1000&spaces=drive`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(await this.http("GET", url, await this.hdrs()), "list");
      for (const f of data.files ?? []) {
        if (!f.name) continue;
        const childPath = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          if (f.id) {
            this.folderIds.set(childPath, f.id);
            await this.walk(f.id, childPath, out);
          }
        } else {
          out.push({ path: childPath, version: f.md5Checksum ?? f.modifiedTime ?? "", size: Number(f.size ?? 0) });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
}
