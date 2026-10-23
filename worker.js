// netgen in a Web Worker.
//
// Protocol (the web app, session.js):
//   {type: "start", id, files: [{path, data}]}   start netgen in /work with these files
//   {type: "eval", id, script}                   evaluate Tcl (a netgen command line)
//   {type: "files", id}                          [{path, mtime, size}] under /work
//   {type: "read", id, path} / {type: "write", id, path, data}
// The worker answers {type: "reply", id, ...}, and while a command runs it
// streams {type: "out", text, error}.  "quit", "exit" or a crash end the
// session with {type: "ended"}.
//
// Paths are relative to /work, the working folder; absolute ones (such as the
// built-in setup files in /setups) are used as they are.

importScripts("netgen.js");

let netgen = null;

function post(message) {
    self.postMessage(message);
}

function mkdirs(path) {
    let dir = "";
    for(const part of path.split("/").filter(Boolean).slice(0, -1)) {
        dir += "/" + part;
        try {
            netgen.FS.mkdir(dir);
        } catch(e) {
            // Exists already
        }
    }
}

function listFiles(root, prefix = "", files = []) {
    for(const name of netgen.FS.readdir(root)) {
        if(name === "." || name === "..") {
            continue;
        }
        const path = root + "/" + name, stat = netgen.FS.stat(path);
        if(netgen.FS.isDir(stat.mode)) {
            listFiles(path, prefix + name + "/", files);
        } else {
            files.push({path: prefix + name, mtime: stat.mtime.getTime(), size: stat.size});
        }
    }
    return files;
}

function ended(error) {
    if(netgen) {
        netgen = null;
        post({type: "ended", error: error ? String(error.message || error) : null});
    }
}

// Run fn; netgen's exit() and aborts end the session.
function guarded(fn) {
    try {
        return fn();
    } catch(error) {
        ended(/ExitStatus|exit\(/.test(String(error)) ? null : error);
        return null;
    }
}

const absolute = path => (path.startsWith("/") ? path : "/work/" + path);

async function start(message) {
    netgen = await createNetgen({
        print: text => post({type: "out", text}),
        printErr: text => post({type: "out", text, error: true}),
        // No keyboard: interactive commands (such as protochip) read end of file.
        stdin: () => null,
        onExit: () => ended(null),
        onAbort: reason => ended(new Error(String(reason))),
    });
    netgen.FS.mkdir("/work");
    for(const file of message.files) {
        const path = absolute(file.path);
        mkdirs(path);
        netgen.FS.writeFile(path, file.data);
    }
    netgen.FS.chdir("/work");
    const code = guarded(() => netgen.ccall("netgen_web_init", "number", ["string", "string"],
        ["/tcl/library", "/netgen/tcl/netgen.tcl"]));
    return {ok: code === 0};
}

function handle(message) {
    switch(message.type) {
    case "eval": {
        const t0 = performance.now();
        const result = guarded(() => netgen.ccall("netgen_web_eval", "string", ["string"], [message.script]));
        const code = netgen ? netgen.ccall("netgen_web_code", "number", [], []) : -1;
        return {result, code, ms: performance.now() - t0};
    }
    case "files":
        return {files: listFiles("/work")};
    case "read":
        return {data: netgen.FS.readFile(absolute(message.path))};
    case "write":
        mkdirs(absolute(message.path));
        netgen.FS.writeFile(absolute(message.path), message.data);
        return {};
    }
    throw new Error("unknown request " + message.type);
}

self.onmessage = async event => {
    const message = event.data;
    try {
        if(message.type === "start") {
            post({type: "reply", id: message.id, ...(await start(message))});
        } else if(!netgen) {
            post({type: "reply", id: message.id, error: "netgen is not running"});
        } else {
            post({type: "reply", id: message.id, ...handle(message)});
        }
    } catch(error) {
        post({type: "reply", id: message.id, error: String(error.message || error)});
    }
};
