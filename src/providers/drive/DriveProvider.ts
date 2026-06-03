import { HttpResponse, HttpSend, PutResult, RemoteObject, RemoteProvider } from "../RemoteProvider";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PATH_KEY = "gsPath"; // appProperties key storing the vault-relative path

export interface DriveConfig {
  appFolderName: string;
}

/** Escape a value for use inside a Drive `q` query (single-quote delimited). */
export function escapeDriveQuery(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Map a Drive files.list response to RemoteObjects (only files this app owns). */
export function parseDriveList(data: { files?: DriveFile[] }, prefix = ""): RemoteObject[] {
  const out: RemoteObject[] = [];
  for (const f of data.files ?? []) {
    const path = f.appProperties?.[PATH_KEY];
    if (!path) continue;
    if (prefix && !path.startsWith(prefix)) continue;
    out.push({ path, version: f.md5Checksum ?? f.modifiedTime ?? "", size: Number(f.size ?? 0) });
  }
  return out;
}

interface DriveFile {
  id?: string;
  appProperties?: Record<string, string>;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

/**
 * Drive provider over the Drive API v3. Uses a single app-managed folder and
 * stores each file's vault-relative path in `appProperties` — which works under
 * the least-privileged `drive.file` scope (the app sees only files it created).
 * Auth is an injected token getter (OAuth Bearer); transport is injected.
 */
export class DriveProvider implements RemoteProvider {
  readonly id = "drive";
  private folderId: string | null = null;

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

  /**
   * The sync folder id. `appFolderName` is treated as a "/"-separated path (e.g.
   * "Obsidian Sync/My Vault"); each segment is found-or-created nested under the
   * previous, starting at the Drive root — so each vault lives in its own
   * subfolder and multiple vaults never collide.
   */
  private async appFolder(): Promise<string> {
    if (this.folderId) return this.folderId;
    let parent = "root";
    for (const name of this.cfg.appFolderName.split("/").map((s) => s.trim()).filter(Boolean)) {
      parent = await this.findOrCreateFolder(name, parent);
    }
    this.folderId = parent;
    return this.folderId;
  }

  private async findOrCreateFolder(name: string, parent: string): Promise<string> {
    const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and '${parent}' in parents and trashed=false`;
    const res = await this.http(
      "GET",
      `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name)")}&spaces=drive`,
      await this.hdrs()
    );
    const data = await this.json<{ files?: DriveFile[] }>(res, "find-folder");
    if (data.files && data.files.length && data.files[0].id) return data.files[0].id;
    const meta = JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] });
    const cr = await this.http("POST", `${API}/files?fields=id`, await this.hdrs({ "content-type": "application/json" }), new TextEncoder().encode(meta).buffer);
    return (await this.json<{ id: string }>(cr, "create-folder")).id;
  }

  private async findByPath(path: string): Promise<{ id: string; version: string; size: number } | null> {
    const folder = await this.appFolder();
    const q = `'${folder}' in parents and appProperties has { key='${PATH_KEY}' and value='${escapeDriveQuery(path)}' } and trashed=false`;
    const res = await this.http(
      "GET",
      `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,md5Checksum,modifiedTime,size)")}&spaces=drive`,
      await this.hdrs()
    );
    const data = await this.json<{ files?: DriveFile[] }>(res, "find");
    const f = data.files && data.files[0];
    return f && f.id ? { id: f.id, version: f.md5Checksum ?? f.modifiedTime ?? "", size: Number(f.size ?? 0) } : null;
  }

  async put(path: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<PutResult> {
    // Drive appProperties values are capped at 124 bytes; fail loudly rather than
    // silently corrupt. (Folder-mirroring to lift this is a planned v2 change.)
    if (new TextEncoder().encode(path).length > 120) {
      throw new Error(`path too long for Drive (>120 bytes): ${path}`);
    }
    const existing = await this.findByPath(path);
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      const folder = await this.appFolder();
      const meta = JSON.stringify({
        name: path.split("/").pop() || path,
        parents: [folder],
        appProperties: { [PATH_KEY]: path },
      });
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
    const f = await this.findByPath(path);
    if (!f) return null;
    const res = await this.http("GET", `${API}/files/${f.id}?alt=media`, await this.hdrs());
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive GET ${path}: ${res.status}`);
    return res.arrayBuffer();
  }

  async head(path: string): Promise<RemoteObject | null> {
    const f = await this.findByPath(path);
    return f ? { path, version: f.version, size: f.size } : null;
  }

  async delete(path: string): Promise<void> {
    const f = await this.findByPath(path);
    if (!f) return;
    const res = await this.http("DELETE", `${API}/files/${f.id}`, await this.hdrs());
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new Error(`Drive DELETE ${path}: ${res.status}`);
  }

  async list(prefix = ""): Promise<RemoteObject[]> {
    const folder = await this.appFolder();
    const out: RemoteObject[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${folder}' in parents and trashed=false`;
      let url =
        `${API}/files?q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent("nextPageToken,files(appProperties,md5Checksum,modifiedTime,size)")}` +
        `&pageSize=1000&spaces=drive`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(await this.http("GET", url, await this.hdrs()), "list");
      out.push(...parseDriveList(data, prefix));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }
}
