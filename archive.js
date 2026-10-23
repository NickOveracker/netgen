// SPDX-License-Identifier: GPL-2.0-or-later
// Reading and writing project archives with the browser's own
// (De)CompressionStream: .zip (stored or deflated entries), .tar, .tar.gz
// and .tgz in; .tar.gz out.  No third-party libraries.
//
// Every reader returns [{path, data: Uint8Array}], with paths cleaned up:
// forward slashes, no leading slash, no "." or ".." parts.

export function cleanPath(path) {
    const parts = [];
    for(const part of path.replace(/\\/g, "/").split("/")) {
        if(part === "" || part === ".") {
            continue;
        }
        if(part === "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join("/");
}

async function inflate(data, format) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data, format) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const text = new TextDecoder();

// ----- zip

export async function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Find the end-of-central-directory record (it may be followed by a comment).
    let eocd = -1;
    for(let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if(view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if(eocd < 0) {
        throw new Error("not a zip file (no central directory)");
    }
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = [];
    for(let n = 0; n < count; n++) {
        if(view.getUint32(p, true) !== 0x02014b50) {
            throw new Error("damaged zip central directory");
        }
        const flags = view.getUint16(p + 8, true);
        const method = view.getUint16(p + 10, true);
        const compressed = view.getUint32(p + 20, true);
        const nameLength = view.getUint16(p + 28, true);
        const extraLength = view.getUint16(p + 30, true);
        const commentLength = view.getUint16(p + 32, true);
        const local = view.getUint32(p + 42, true);
        const name = text.decode(bytes.subarray(p + 46, p + 46 + nameLength));
        p += 46 + nameLength + extraLength + commentLength;

        if(name.endsWith("/")) {
            continue;
        }
        if(flags & 1) {
            throw new Error(`${name}: encrypted zip entries are not supported`);
        }
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + compressed);
        let data;
        if(method === 0) {
            data = raw.slice();
        } else if(method === 8) {
            data = await inflate(raw, "deflate-raw");
        } else {
            throw new Error(`${name}: zip compression method ${method} is not supported`);
        }
        files.push({path: cleanPath(name), data});
    }
    return files;
}

// ----- tar

function octal(bytes, start, length) {
    const s = text.decode(bytes.subarray(start, start + length)).replace(/\0.*$/, "").trim();
    return s ? parseInt(s, 8) : 0;
}

function field(bytes, start, length) {
    return text.decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, "");
}

export function readTar(bytes) {
    const files = [];
    let p = 0, longName = null, paxPath = null;
    while(p + 512 <= bytes.length) {
        const header = bytes.subarray(p, p + 512);
        if(header.every(b => b === 0)) {
            break;
        }
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 48);
        let name = field(header, 0, 100);
        if(field(header, 257, 6) === "ustar") {
            const prefix = field(header, 345, 155);
            if(prefix) {
                name = prefix + "/" + name;
            }
        }
        const data = bytes.subarray(p + 512, p + 512 + size);
        p += 512 + Math.ceil(size / 512) * 512;

        if(type === "L") {                         // GNU long name for the next entry
            longName = field(data, 0, data.length);
            continue;
        }
        if(type === "x") {                         // pax extended header
            for(const line of text.decode(data).split("\n")) {
                const m = /^\d+ path=(.*)$/.exec(line);
                if(m) {
                    paxPath = m[1];
                }
            }
            continue;
        }
        if(type === "g") {
            continue;
        }
        name = paxPath || longName || name;
        paxPath = longName = null;
        if(type === "0" || type === "\0" || type === "7") {
            files.push({path: cleanPath(name), data: data.slice()});
        }
    }
    return files;
}

// ----- by name

export function isArchive(name) {
    return /\.(zip|tar|tgz|tar\.gz)$/i.test(name);
}

export async function readArchive(name, bytes) {
    if(/\.zip$/i.test(name)) {
        return readZip(bytes);
    }
    if(/\.(tgz|tar\.gz)$/i.test(name)) {
        return readTar(await inflate(bytes, "gzip"));
    }
    if(/\.tar$/i.test(name)) {
        return readTar(bytes);
    }
    throw new Error(`${name}: not a .zip, .tar, .tar.gz or .tgz file`);
}

// If every path starts with the same folder, drop it, so a zip of "project/" and a
// pick of the folder "project" both give the same layout.
export function stripCommonFolder(files) {
    if(!files.length) {
        return files;
    }
    const first = files[0].path.split("/");
    if(first.length < 2) {
        return files;
    }
    const folder = first[0] + "/";
    if(!files.every(f => f.path.startsWith(folder))) {
        return files;
    }
    return stripCommonFolder(files.map(f => ({...f, path: f.path.slice(folder.length)})));
}

// ----- writing .tar.gz

function writeString(header, start, length, value) {
    const bytes = new TextEncoder().encode(value);
    header.set(bytes.subarray(0, length), start);
}

function writeOctal(header, start, length, value) {
    writeString(header, start, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

export async function writeTarGz(files) {
    const chunks = [];
    const mtime = Math.floor(Date.now() / 1000);
    for(const {path, data} of files) {
        const header = new Uint8Array(512);
        let name = path, prefix = "";
        if(name.length > 100) {
            const cut = name.lastIndexOf("/", 155);
            prefix = name.slice(0, cut);
            name = name.slice(cut + 1);
        }
        writeString(header, 0, 100, name);
        writeOctal(header, 100, 8, 0o644);
        writeOctal(header, 108, 8, 0);
        writeOctal(header, 116, 8, 0);
        writeOctal(header, 124, 12, data.length);
        writeOctal(header, 136, 12, mtime);
        header.fill(32, 148, 156);                 // Checksum field counts as spaces
        header[156] = 48;                          // "0": regular file
        writeString(header, 257, 6, "ustar\0");
        writeString(header, 263, 2, "00");
        writeString(header, 345, 155, prefix);
        let sum = 0;
        for(const b of header) {
            sum += b;
        }
        writeString(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
        chunks.push(header, data);
        const pad = (512 - data.length % 512) % 512;
        if(pad) {
            chunks.push(new Uint8Array(pad));
        }
    }
    chunks.push(new Uint8Array(1024));
    const tar = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for(const c of chunks) {
        tar.set(c, p);
        p += c.length;
    }
    return deflate(tar, "gzip");
}
