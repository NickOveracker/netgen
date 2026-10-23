// Keeping projects between visits.
//
// Two kinds of store, with the same interface (readAll, write):
//   DiskStore     a real folder chosen with showDirectoryPicker() (Chromium
//                 browsers).  Files the program writes are copied into it.
//   BrowserStore  the browser's own storage (IndexedDB), in every browser.
//                 Persistent, but only reachable through this page.
//
// The list of recent projects, and the folder handles needed to reopen disk
// projects, are kept in IndexedDB too.

export const diskSupported = typeof window.showDirectoryPicker === "function";

const DB_NAME = "netgen-web";
const SKIP_FOLDERS = new Set([".git", "node_modules", ".svn", ".hg", "__pycache__"]);
const MAX_FILE = 64 * 1024 * 1024;

let dbPromise = null;

function db() {
    if(!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const d = request.result;
                d.createObjectStore("projects", {keyPath: "id"});
                d.createObjectStore("files");          // key: [projectId, path]
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

async function transaction(stores, mode, work) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(stores, mode);
        let result;
        Promise.resolve(work(tx)).then(value => {
            result = value;
        }, reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});

// ----- Recent projects: {id, name, kind: "disk" | "browser", handle?, used}

export async function recentProjects() {
    try {
        const all = await transaction(["projects"], "readonly", tx => request(tx.objectStore("projects").getAll()));
        return all.sort((a, b) => b.used - a.used);
    } catch(e) {
        return [];
    }
}

async function remember(entry) {
    await transaction(["projects"], "readwrite", tx => {
        tx.objectStore("projects").put({...entry, used: Date.now()});
    });
}

export async function forget(id) {
    await transaction(["projects", "files"], "readwrite", tx => {
        tx.objectStore("projects").delete(id);
        tx.objectStore("files").delete(IDBKeyRange.bound([id, ""], [id, "￿"]));
    });
}

// Ask the browser not to clear our storage under pressure (it may say no).
export async function persist() {
    try {
        return await navigator.storage?.persist?.();
    } catch(e) {
        return false;
    }
}

// ----- A real folder

export class DiskStore {
    constructor(handle, id) {
        this.handle = handle;
        this.id = id;
        this.name = handle.name;
        this.label = `folder "${handle.name}"`;
    }

    static async pick() {
        const handle = await window.showDirectoryPicker({id: "netgen-project", mode: "readwrite"});
        // The same folder picked again keeps its place in the recent list.
        let id = null;
        for(const entry of await recentProjects()) {
            if(entry.kind === "disk" && await entry.handle.isSameEntry(handle)) {
                id = entry.id;
            }
        }
        const store = new DiskStore(handle, id || `disk:${handle.name}:${Date.now()}`);
        await store.remember();
        return store;
    }

    // Reopening needs the user's permission again; call this from a click.
    static async reopen(entry) {
        const store = new DiskStore(entry.handle, entry.id);
        const options = {mode: "readwrite"};
        if(await entry.handle.queryPermission(options) !== "granted" &&
            await entry.handle.requestPermission(options) !== "granted") {
            throw new Error(`No permission to use the folder "${entry.handle.name}".`);
        }
        await store.remember();
        return store;
    }

    remember() {
        return remember({id: this.id, name: this.name, kind: "disk", handle: this.handle});
    }

    async readAll() {
        const files = [];
        const walk = async (dir, prefix) => {
            for await (const [name, entry] of dir.entries()) {
                if(entry.kind === "directory") {
                    if(!SKIP_FOLDERS.has(name)) {
                        await walk(entry, prefix + name + "/");
                    }
                } else {
                    const file = await entry.getFile();
                    if(file.size <= MAX_FILE) {
                        files.push({path: prefix + name, data: new Uint8Array(await file.arrayBuffer())});
                    }
                }
            }
        };
        await walk(this.handle, "");
        return files;
    }

    async write(path, data) {
        const parts = path.split("/");
        let dir = this.handle;
        for(const part of parts.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(part, {create: true});
        }
        const file = await dir.getFileHandle(parts[parts.length - 1], {create: true});
        const writable = await file.createWritable();
        await writable.write(data);
        await writable.close();
    }
}

// ----- The browser's storage

export class BrowserStore {
    constructor(name) {
        this.id = "browser:" + name;
        this.name = name;
        this.label = "browser storage";
    }

    static async create(name) {
        const store = new BrowserStore(name);
        await store.remember();
        persist();
        return store;
    }

    static reopen(entry) {
        return new BrowserStore(entry.name);
    }

    remember() {
        return remember({id: this.id, name: this.name, kind: "browser"});
    }

    async readAll() {
        const range = IDBKeyRange.bound([this.id, ""], [this.id, "￿"]);
        await this.remember();
        return transaction(["files"], "readonly", async tx => {
            const store = tx.objectStore("files");
            const [keys, values] = await Promise.all([request(store.getAllKeys(range)), request(store.getAll(range))]);
            return keys.map((key, i) => ({path: key[1], data: values[i]}));
        });
    }

    async write(path, data) {
        await transaction(["files"], "readwrite", tx => {
            tx.objectStore("files").put(data, [this.id, path]);
        });
    }
}

export function reopen(entry) {
    return entry.kind === "disk" ? DiskStore.reopen(entry) : BrowserStore.reopen(entry);
}
