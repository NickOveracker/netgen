// netgen in the browser: LVS (comparing two netlists) with netgen compiled
// to WebAssembly together with Tcl.  The Compare window sets up and runs
// netgen's "lvs" command, the Result window shows what it found (from its
// JSON output and report), and the console takes any netgen or Tcl command.
// Projects are files, folders or archives, kept in a folder on disk or in the
// browser's storage, as in the IRSIM and Magic apps.

import {Session} from "./session.js";
import {FloatingWindow, topEdgeResizer, paneResizer} from "./floating-window.js";
import {menuBar, closeMenus} from "./menu.js";
import {ask, setHomeFocus} from "./dialog.js";
import {readArchive, isArchive, stripCommonFolder, cleanPath, writeTarGz} from "./archive.js";
import {diskSupported, DiskStore, BrowserStore, recentProjects, reopen, forget} from "./storage.js";

const $ = selector => document.querySelector(selector);
const desktop = $("#desktop");
topEdgeResizer($("#console"), desktop, {label: "Resize the console"});
const log = $("#log");
const commandInput = $("#command");
const statusEl = $("#status");

// Each example: its files (examples/<name>/), and the comparison it runs.
const EXAMPLES = {
    inverter: {label: "Inverter: layout vs schematic (match)", files: ["inverter_tap.spice", "inverter_schematic.spice", "setup.tcl", "inverter_tap.mag"],
        circuit1: ["inverter_tap.spice", "inverter_tap"], circuit2: ["inverter_schematic.spice", "inverter"]},
    inverter_floating_well: {label: "Inverter as exported from Stixu: floating n-well",
        files: ["inverter.spice", "inverter_schematic.spice", "setup.tcl", "inverter.mag"],
        circuit1: ["inverter.spice", "inverter"], circuit2: ["inverter_schematic.spice", "inverter"]},
    full_adder_sizes: {label: "Full adder: two sizings (property errors)", files: ["full_adder.spice", "full_adder_path.spice", "setup.tcl"],
        circuit1: ["full_adder.spice", "full_adder"], circuit2: ["full_adder_path.spice", "full_adder_path"]},
    full_adder_miswired: {label: "Full adder: a miswired gate", files: ["full_adder.spice", "full_adder_miswired.spice", "setup.tcl"],
        circuit1: ["full_adder.spice", "full_adder"], circuit2: ["full_adder_miswired.spice", "full_adder_miswired"]},
    mult4_sizes: {label: "4×4 multiplier: two sizings (338 transistors)", files: ["mult4.spice", "mult4_path.spice", "setup.tcl"],
        circuit1: ["mult4.spice", "mult4"], circuit2: ["mult4_path.spice", "mult4_path"]},
};
const DEFAULT_EXAMPLE = "inverter";
// Setup files built into the app, kept apart from the project's files.
const BUILT_IN_SETUPS = {"/setups/scmos.tcl": "scmos (Magic): equate nfet/pfet with n/p"};
const NETLIST = /\.(spice|spi|sp|cir|ckt|cdl|net|netlist|sim|ext|v|vg|ntk)$/i;
const here = path => new URL(path, import.meta.url);

let project = null;          // {name, files: [{path, data}], store, synced, compare: {circuit1, circuit2, setup, blackbox}}
let lastResult = null;       // {verdict, kind, report, json, command, ms}
let capturedErrors = null;   // Error lines printed while Run LVS runs

// ----- Output

function print(text, kind) {
    const line = document.createElement("div");
    line.className = "log-line" + (kind ? " log-" + kind : "");
    line.textContent = text;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.appendChild(line);
    while(log.childElementCount > 5000) {
        log.firstElementChild.remove();
    }
    if(atBottom) {
        log.scrollTop = log.scrollHeight;
    }
}

function saveBlob(name, blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ----- The session

const session = new Session({
    onOutput: (text, error) => {
        if(error && capturedErrors && text.trim()) {
            capturedErrors.push(text.trim());
        }
        print(text, error ? "error" : null);
    },
    onState: () => updateStatus(),
});

function updateStatus() {
    $("#stop").hidden = !session.busy;
    if(session.busy) {
        statusEl.textContent = `Running ${session.current.split("\n")[0].slice(0, 60)}…`;
        return;
    }
    if(!project) {
        statusEl.textContent = "Ready";
        return;
    }
    const where = project.store ? (project.syncError ? ` · not saved to ${project.store.label}!` : ` · kept in ${project.store.label}`) :
        " · in memory only";
    const result = lastResult ? ` · ${lastResult.short}` : "";
    statusEl.textContent = `${project.name}${result}${where}`;
}

// Commands that would end netgen (and the session with it) are the page's.
function frontEnd(line) {
    if(/^\s*(quit|exit)\b/.test(line)) {
        print("netgen keeps running in the browser; Project > Restart netgen starts it afresh.", "info");
        return null;
    }
    return line;
}

// Run a command line, echoed in the console.
async function run(line, {echo = true} = {}) {
    if(echo) {
        print("netgen> " + line, "command");
    }
    const real = frontEnd(line);
    if(real === null || !real.trim()) {
        return null;
    }
    if(!session.started) {
        print("netgen isn't running: open a project or an example.", "error");
        return null;
    }
    let reply = null;
    try {
        reply = await session.run(real);
        if(!reply.ended && reply.result) {
            print(reply.result, reply.code === 0 ? null : "error");
        }
    } catch(error) {
        if(error.message !== "stopped") {
            print(String(error.message || error), "error");
        }
    }
    scheduleSync();
    filesWindow.refresh();
    updateStatus();
    return reply;
}

// ----- Netlists and the comparison

// Cells a netlist file defines, for the cell choices: SPICE subcircuits and
// Verilog modules.  Other formats hold one cell, the file itself.
function cellsIn(path) {
    const file = project?.files.find(f => f.path === path);
    if(!file) {
        return [];
    }
    const text = decoder.decode(file.data.length > 4e6 ? file.data.subarray(0, 4e6) : file.data);
    const pattern = /\.(v|vg)$/i.test(path) ? /^\s*module\s+([\w$\\]+)/gim : /^\s*\.subckt\s+(\S+)/gim;
    return [...text.matchAll(pattern)].map(m => m[1]);
}

function defaultCell(path) {
    const cells = cellsIn(path);
    const base = path.split("/").pop().replace(/\.\w+$/, "");
    return cells.find(c => c.toLowerCase() === base.toLowerCase()) || cells[cells.length - 1] || "";
}

// Which netlist is the layout (circuit 1) and which the schematic: extracted
// netlists say so in their first line; otherwise the order of the files.
function defaultCompare(files) {
    const netlists = files.map(f => f.path).filter(p => NETLIST.test(p));
    const extracted = p => /created from .*\.ext|extracted/i.test(decoder.decode(files.find(f => f.path === p).data.subarray(0, 200)));
    const schematic = p => /sch/i.test(p);
    const sorted = [...netlists.filter(p => extracted(p) && !schematic(p)), ...netlists.filter(p => !extracted(p) && !schematic(p)),
        ...netlists.filter(p => schematic(p))];
    const [a, b] = [...new Set(sorted)];
    const setups = files.map(f => f.path).filter(p => /\.tcl$/i.test(p));
    return {circuit1: [a || "", ""], circuit2: [b || "", ""], setup: setups.find(p => /setup/i.test(p)) || setups[0] || "", blackbox: false};
}

function circuitArg([file, cell]) {
    const brace = s => (/^[^\s{}\\"[\]$;]+$/.test(s) ? s : `{${s}}`);
    return cell ? `{${brace(file)} ${brace(cell)}}` : brace(file);
}

function lvsCommand(compare) {
    const setup = compare.setup || "nosetup";
    return `lvs ${circuitArg(compare.circuit1)} ${circuitArg(compare.circuit2)} ${setup} comp.out -json` +
        (compare.blackbox ? " -blackbox" : "");
}

// netgen's verdict, from its report: the "Final result" and anything before
// it that says the netlists don't match.
function verdictOf(report) {
    const i = report.lastIndexOf("Final result:");
    // The final result, without the lone "." netgen prints after it.
    let final = i < 0 ? "" : report.slice(i + 13).split(/\n\s*\n|\nThe following/)[0].replace(/\s+/g, " ").trim().replace(/(\s+\.)+$/, "");
    if(/Netlists do not match/.test(report.slice(0, i)) && !/do not match/.test(final)) {
        final = "Netlists do not match. " + final;
    }
    let kind, short;
    if(i < 0) {
        kind = "fail";
        short = "no result";
    } else if(/do not match|failed|not unique|locally but not globally/i.test(report.slice(0, i) + final)) {
        kind = "fail";
        short = "do not match";
    } else if(/property errors|port errors|Property errors were found/i.test(report.slice(i))) {
        kind = "warn";
        short = "match, with property errors";
    } else if(/match/i.test(final)) {
        kind = "pass";
        short = "match";
    } else {
        kind = "warn";
        short = final.toLowerCase();
    }
    return {final: final || "netgen gave no final result (see the console)", kind, short};
}

async function runLvs() {
    if(!project) {
        return;
    }
    const compare = project.compare;
    if(!compare.circuit1[0] || !compare.circuit2[0]) {
        print("Choose two netlists to compare in the Compare window.", "error");
        compareWindow.open();
        return;
    }
    // A fresh database each time, so edited files are read again, and no
    // report from an earlier run that could be taken for this one's.
    await run("reinitialize; file delete -force comp.out comp.json", {echo: false});
    const command = lvsCommand(compare);
    const t0 = performance.now();
    capturedErrors = [];
    const reply = await run(command);
    const errors = capturedErrors;
    capturedErrors = null;
    if(!reply || reply.ended) {
        return;
    }
    let report = "", json = null;
    try {
        report = decoder.decode(await session.readFile("comp.out"));
    } catch(e) {
        // No report: netgen stopped early; the console says why.
    }
    try {
        json = JSON.parse(decoder.decode(await session.readFile("comp.json")));
    } catch(e) {
        json = null;
    }
    const verdict = report ? verdictOf(report) :
        {final: `netgen wrote no report: ${(reply.result || errors[errors.length - 1] || "see the console").trim()}`, kind: "fail", short: "no result"};
    lastResult = {...verdict, report, json, command, ms: performance.now() - t0, compare: structuredClone(compare)};
    print(`Result: ${verdict.final}`, verdict.kind === "pass" ? "info" : "error");
    resultWindow.open();
    resultWindow.render();
    updateStatus();
}

// ----- Projects

async function builtInSetups() {
    const files = [];
    for(const path of Object.keys(BUILT_IN_SETUPS)) {
        const response = await fetch(here(path.slice(1)));
        if(response.ok) {
            files.push({path, data: new Uint8Array(await response.arrayBuffer())});
        }
    }
    return files;
}

async function startNetgen() {
    lastResult = null;
    resultWindow.render();
    const ok = await session.start([...project.files, ...await builtInSetups()]);
    project.synced = new Map((await session.listFiles()).map(f => [f.path, f.mtime]));
    if(!ok) {
        print("netgen could not start.", "error");
    }
    filesWindow.refresh();
    compareWindow.refresh();
    updateStatus();
    return ok;
}

async function loadProject(name, files, store = null, compare = null) {
    files = store ? files.filter(f => f.path) : stripCommonFolder(files.filter(f => f.path));
    name = name.replace(/\.(zip|tar|tgz|tar\.gz|spice|sp|cir|sim|v|tcl)$/i, "").replace(/[^\w.-]+/g, "_") || "project";
    if(!files.length && !store) {
        print("No files to load.", "error");
        return false;
    }
    project = {name, files, store, synced: new Map(), compare: compare || defaultCompare(files)};
    for(const key of ["circuit1", "circuit2"]) {
        if(project.compare[key][0] && !project.compare[key][1]) {
            project.compare[key][1] = defaultCell(project.compare[key][0]);
        }
    }
    document.title = `${name} · netgen`;
    print(`Opened ${name}: ${files.map(f => f.path).join(", ") || "no files yet"}`, "info");
    if(!await startNetgen()) {
        return false;
    }
    compareWindow.open();
    return true;
}

async function loadExample(name) {
    const example = EXAMPLES[name];
    statusEl.textContent = `Loading ${name}…`;
    const files = [];
    for(const file of example.files) {
        const url = here(`examples/${name}/${file}`);
        const response = await fetch(url);
        if(!response.ok) {
            throw new Error(`Couldn't load the example ${url}: HTTP ${response.status}`);
        }
        files.push({path: file, data: new Uint8Array(await response.arrayBuffer())});
    }
    const compare = {circuit1: [...example.circuit1], circuit2: [...example.circuit2], setup: "setup.tcl", blackbox: false};
    if(await loadProject(name, files, null, compare)) {
        await runLvs();
    }
}

async function restart() {
    if(project) {
        print("Restarting netgen.", "info");
        project.files = await currentFiles();
        await startNetgen();
    }
}

// ----- Keeping projects (storage.js)

let syncTimer = null, syncing = false, syncAgain = false;
const isProjectFile = path => !path.startsWith("/");

function scheduleSync() {
    if(!project || !project.store || syncTimer) {
        return;
    }
    syncTimer = setTimeout(() => {
        syncTimer = null;
        syncProject();
    }, 300);
}

// Copy files netgen wrote (reports, written netlists, logs) and edits into the project's store.
async function syncProject() {
    if(!project || !project.store || !session.started) {
        return;
    }
    if(syncing) {
        syncAgain = true;
        return;
    }
    syncing = true;
    const current = project;
    try {
        const written = [];
        for(const f of await session.listFiles()) {
            if(current.synced.get(f.path) !== f.mtime) {
                const data = await session.readFile(f.path);
                await current.store.write(f.path, data);
                session.remember(f.path, data);
                const known = current.files.find(x => x.path === f.path);
                known ? (known.data = data) : current.files.push({path: f.path, data});
                current.synced.set(f.path, f.mtime);
                written.push(f.path);
            }
        }
        current.syncError = null;
        if(written.length) {
            print(`Saved ${written.join(", ")} to ${current.store.label}`, "info");
            filesWindow.refresh();
        }
    } catch(error) {
        current.syncError = error;
        print(`Couldn't save to ${current.store.label}: ${error.message || error}`, "error");
    } finally {
        syncing = false;
        updateStatus();
        if(syncAgain) {
            syncAgain = false;
            syncProject();
        }
    }
}

// The project's files as they are now (including what netgen wrote).
async function currentFiles() {
    if(!session.started) {
        return project.files;
    }
    const files = [];
    for(const f of await session.listFiles()) {
        files.push({path: f.path, data: await session.readFile(f.path)});
    }
    return files;
}

let recent = [];

async function refreshRecent() {
    recent = await recentProjects();
}

async function openStore(store) {
    statusEl.textContent = `Reading ${store.label}…`;
    const files = await store.readAll();
    if(await loadProject(store.name, files, store)) {
        print(`Working in ${store.label}: reports netgen writes and your edits are saved there.`, "info");
    }
    refreshRecent();
}

async function keepProject(store) {
    if(!project) {
        return;
    }
    const files = await currentFiles();
    for(const f of files) {
        await store.write(f.path, f.data);
    }
    project.store = store;
    project.files = files;
    project.synced = new Map((session.started ? await session.listFiles() : []).map(f => [f.path, f.mtime]));
    print(`Saved ${files.length} file${files.length === 1 ? "" : "s"} to ${store.label}; later changes go there too.`, "info");
    updateStatus();
    refreshRecent();
}

async function download() {
    if(!project) {
        return;
    }
    const files = await currentFiles();
    saveBlob(project.name + ".tar.gz", new Blob([await writeTarGz(files.map(f => ({path: project.name + "/" + f.path, data: f.data})))],
        {type: "application/gzip"}));
    print(`Saved ${files.length} file${files.length === 1 ? "" : "s"} to ${project.name}.tar.gz`, "info");
}

async function attempt(work) {
    try {
        await work();
    } catch(error) {
        if(error && error.name === "AbortError") {
            return;
        }
        print(String(error.message || error), "error");
        updateStatus();
    }
}

const NEEDS_CHROMIUM = "Needs Chrome, Edge or another Chromium browser (the File System Access API)";

function projectMenu() {
    const items = [
        {label: "Open files…", action: () => $("#pick-files").click()},
        {label: "Open folder (copy)…", action: () => $("#pick-folder").click()},
        "-",
        {label: "Work in a folder on disk…", disabled: !diskSupported, title: diskSupported ?
            "Open a folder; reports netgen writes and your edits are saved into it" : NEEDS_CHROMIUM,
        action: () => attempt(async () => openStore(await DiskStore.pick()))},
        {label: "Save project to a folder on disk…", disabled: !diskSupported || !project, title: diskSupported ?
            "Copy this project into a folder and keep working there" : NEEDS_CHROMIUM,
        action: () => attempt(async () => keepProject(await DiskStore.pick()))},
        {label: "Keep project in browser storage", disabled: !project || project.store instanceof BrowserStore,
            title: "Saves into this browser (private to this site) and keeps it there",
            action: () => attempt(async () => keepProject(await BrowserStore.create(project.name)))},
    ];
    if(recent.length) {
        items.push("-");
        for(const entry of recent.slice(0, 8)) {
            items.push({label: `Reopen ${entry.name} (${entry.kind === "disk" ? "folder" : "browser storage"})`,
                action: () => attempt(async () => openStore(await reopen(entry)))});
        }
        items.push({label: "Forget recent projects…", action: () => attempt(async () => {
            const stored = recent.filter(e => e.kind === "browser").map(e => e.name);
            const warning = stored.length ? ` This deletes ${stored.join(", ")} from browser storage.` : "";
            if(window.confirm(`Forget the recent projects?${warning} Folders on disk are not touched.`)) {
                for(const entry of recent) {
                    await forget(entry.id);
                }
                await refreshRecent();
            }
        })});
    }
    items.push("-",
        {label: "Run LVS", disabled: !project, action: () => attempt(runLvs)},
        {label: "Restart netgen", disabled: !project, action: () => attempt(restart)},
        "-",
        {label: "Download project (.tar.gz)", disabled: !project, action: () => attempt(download)});
    return items;
}

// ----- Compare window: the two netlists, the setup, and Run

class CompareWindow {
    constructor() {
        this.fw = null;
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open() {
        if(this.fw) {
            this.fw.raise();
            this.refresh();
            return;
        }
        this.fw = new FloatingWindow(desktop, {
            title: "Compare", x: 12, y: 12, width: Math.min(440, desktop.clientWidth - 24), height: Math.min(392, desktop.clientHeight - 24),
            onClose: () => this.close(),
        });
        const circuit = (n, label) => `<fieldset><legend>${label}</legend>
            <label>Netlist <select data-field="file${n}"></select></label>
            <label>Cell <input data-field="cell${n}" list="cells${n}" spellcheck="false" placeholder="(the file's top cell)"><datalist id="cells${n}"></datalist></label>
            </fieldset>`;
        this.fw.body.innerHTML = `<form class="cmp-form">
            ${circuit(1, "Circuit 1: usually the layout (extracted netlist)")}
            ${circuit(2, "Circuit 2: usually the schematic")}
            <label class="cmp-wide">Setup <select data-field="setup"></select></label>
            <label class="cmp-check"><input type="checkbox" data-field="blackbox"> Treat empty subcircuits as black boxes</label>
            <div class="cmp-buttons"><button type="submit" class="primary">Run LVS</button><button type="button" data-act="swap">Swap</button></div>
            <code class="cmp-command"></code>
            </form>`;
        this.form = this.fw.body.querySelector("form");
        this.form.addEventListener("submit", event => {
            event.preventDefault();
            attempt(runLvs);
        });
        this.form.addEventListener("change", event => this.read(event.target));
        this.form.addEventListener("input", event => this.read(event.target));
        this.form.querySelector("[data-act=swap]").addEventListener("click", () => {
            if(project) {
                [project.compare.circuit1, project.compare.circuit2] = [project.compare.circuit2, project.compare.circuit1];
                this.refresh();
            }
        });
        this.refresh();
    }

    close() {
        this.fw?.remove();
        this.fw = null;
    }

    field(name) {
        return this.form.querySelector(`[data-field="${name}"]`);
    }

    // Choices and values from the project.
    refresh() {
        if(!this.fw) {
            return;
        }
        const disabled = !project;
        for(const el of this.form.elements) {
            el.disabled = disabled;
        }
        if(!project) {
            this.form.querySelector(".cmp-command").textContent = "Open a project or an example.";
            return;
        }
        const compare = project.compare;
        const netlists = project.files.map(f => f.path).filter(p => NETLIST.test(p)).sort();
        for(const n of [1, 2]) {
            const [file, cell] = compare["circuit" + n];
            const select = this.field("file" + n);
            select.textContent = "";
            for(const path of new Set([...netlists, ...(file ? [file] : [])])) {
                select.add(new Option(path, path, false, path === file));
            }
            if(!netlists.length) {
                select.add(new Option("(no netlists in the project)", ""));
            }
            this.field("cell" + n).value = cell;
            const list = this.form.querySelector("#cells" + n);
            list.textContent = "";
            for(const c of cellsIn(file)) {
                list.appendChild(new Option(c));
            }
        }
        const setup = this.field("setup");
        setup.textContent = "";
        setup.add(new Option("none (netgen's defaults)", ""));
        for(const path of project.files.map(f => f.path).filter(p => /\.tcl$/i.test(p))) {
            setup.add(new Option(path + " (project)", path));
        }
        for(const [path, label] of Object.entries(BUILT_IN_SETUPS)) {
            setup.add(new Option(label + " (built in)", path));
        }
        setup.value = compare.setup;
        this.field("blackbox").checked = compare.blackbox;
        this.form.querySelector(".cmp-command").textContent = lvsCommand(compare);
    }

    read(el) {
        if(!project || !el.dataset.field) {
            return;
        }
        const compare = project.compare, name = el.dataset.field;
        if(/^file\d$/.test(name)) {
            const key = "circuit" + name.slice(-1);
            compare[key] = [el.value, defaultCell(el.value)];
            this.refresh();
            return;
        }
        if(/^cell\d$/.test(name)) {
            compare["circuit" + name.slice(-1)][1] = el.value.trim();
        } else if(name === "setup") {
            compare.setup = el.value;
        } else if(name === "blackbox") {
            compare.blackbox = el.checked;
        }
        this.form.querySelector(".cmp-command").textContent = lvsCommand(compare);
    }
}

const compareWindow = new CompareWindow();

// ----- Result window: what netgen found

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for(const [k, v] of Object.entries(attrs)) {
        k === "class" ? (el.className = v) : el.setAttribute(k, v);
    }
    for(const child of children.flat()) {
        if(child !== null && child !== undefined && child !== false) {
            el.append(child instanceof Node ? child : String(child));
        }
    }
    return el;
}

const NO_MATCH = /^\(no matching/;

class ResultWindow {
    constructor() {
        this.fw = null;
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open() {
        if(this.fw) {
            this.fw.raise();
            return;
        }
        const x = Math.min(468, Math.max(12, desktop.clientWidth - 560));
        this.fw = new FloatingWindow(desktop, {
            title: "Result", x, y: 12, width: Math.min(620, desktop.clientWidth - x - 12), height: Math.max(200, desktop.clientHeight - 24),
            onClose: () => this.close(),
        });
        this.fw.body.classList.add("res-body");
        this.render();
    }

    close() {
        this.fw?.remove();
        this.fw = null;
    }

    render() {
        if(!this.fw) {
            return;
        }
        const body = this.fw.body;
        body.textContent = "";
        if(!lastResult) {
            body.append(h("p", {class: "res-empty"}, project ? "Run LVS from the Compare window to see what netgen finds." :
                "Open a project or an example."));
            return;
        }
        const r = lastResult;
        const icon = {pass: "✓", warn: "!", fail: "✕"}[r.kind];
        body.append(h("div", {class: `res-verdict res-${r.kind}`}, h("span", {class: "res-icon", "aria-hidden": "true"}, icon),
            h("div", {}, h("strong", {}, r.final), h("div", {class: "res-sub"},
                `${circuitArg(r.compare.circuit1)} vs ${circuitArg(r.compare.circuit2)} · ${(r.ms / 1000).toFixed(2)} s`))));
        const actions = h("div", {class: "res-actions"},
            h("button", {type: "button", "data-act": "report"}, "Download report"),
            r.json ? h("button", {type: "button", "data-act": "json"}, "Download JSON") : null);
        actions.addEventListener("click", event => {
            const act = event.target.closest("button")?.dataset.act;
            if(act === "report") {
                saveBlob("comp.out", new Blob([r.report], {type: "text/plain"}));
            } else if(act === "json") {
                saveBlob("comp.json", new Blob([JSON.stringify(r.json, null, 1)], {type: "application/json"}));
            }
        });
        body.append(actions);
        for(const cell of r.json || []) {
            body.append(this.cell(cell));
        }
        body.append(h("details", {class: "res-report"}, h("summary", {}, "Full report (comp.out)"), h("pre", {}, r.report || "(none)")));
    }

    // One compared cell (pair of subcircuits) from netgen's JSON.
    cell(c) {
        const [n1, n2] = c.name || ["circuit 1", "circuit 2"];
        const section = h("section", {class: "res-cell"}, h("h3", {}, `${n1} ↔ ${n2}`));
        // Devices by class, and nets.
        const classes = new Map();
        (c.devices || []).forEach((list, side) => {
            for(const [cls, count] of list) {
                classes.set(cls, classes.get(cls) || [0, 0]);
                classes.get(cls)[side] = count;
            }
        });
        const rows = [...classes].map(([cls, [a, b]]) => h("tr", {class: a !== b ? "res-diff" : ""}, h("td", {}, cls), h("td", {}, a), h("td", {}, b)));
        const [nets1, nets2] = c.nets || [];
        rows.push(h("tr", {class: nets1 !== nets2 ? "res-diff" : ""}, h("td", {}, h("em", {}, "nets")), h("td", {}, nets1), h("td", {}, nets2)));
        section.append(h("table", {class: "res-table"}, h("thead", {}, h("tr", {}, h("th", {}, "Devices"), h("th", {}, n1), h("th", {}, n2))),
            h("tbody", {}, rows)));
        // Nets and devices that differ: pairs of fragments, one per circuit.
        const fragments = (groups, title, describe) => {
            if(!groups || !groups.length) {
                return;
            }
            section.append(h("h4", {}, title));
            for(const [left, right] of groups) {
                section.append(h("div", {class: "res-pair"}, h("div", {}, (left || []).map(describe)), h("div", {}, (right || []).map(describe))));
            }
        };
        fragments(c.badnets, "Nets that differ", ([name, conns]) => h("div", {class: "res-frag" + (NO_MATCH.test(name) ? " res-none" : "")},
            h("strong", {}, name), (conns || []).filter(([cls]) => cls).map(([cls, pin, count]) => h("div", {}, `${cls}/${pin} × ${count}`))));
        fragments(c.badelements, "Devices that differ", ([name, pins]) => h("div", {class: "res-frag" + (NO_MATCH.test(name) ? " res-none" : "")},
            h("strong", {}, name), (pins || []).filter(([pin]) => pin).map(([pin, fanout]) => h("div", {}, `${pin}: net with ${fanout} connections`))));
        // Property differences: pairs of instances with their values.
        if(c.properties && c.properties.length) {
            section.append(h("h4", {}, `Property differences (${c.properties.length})`));
            const table = h("table", {class: "res-table res-props"}, h("thead", {}, h("tr", {}, h("th", {}, n1), h("th", {}, n2))));
            const tbody = h("tbody");
            for(const pair of c.properties.slice(0, 200)) {
                const side = s => (s ? [h("strong", {}, s[0]), " ", (s[1] || []).map(([k, v]) => `${k}=${v}`).join(" ")] : "");
                tbody.append(h("tr", {}, h("td", {}, side(pair[0])), h("td", {}, side(pair[1]))));
            }
            table.append(tbody);
            section.append(table);
            if(c.properties.length > 200) {
                section.append(h("p", {class: "res-sub"}, `…and ${c.properties.length - 200} more in the full report.`));
            }
        }
        // Pins.
        if(c.pins && c.pins.length === 2) {
            const [p1, p2] = c.pins, count = Math.max(p1.length, p2.length);
            const bad = [...Array(count).keys()].some(i => NO_MATCH.test(p1[i] || "") || NO_MATCH.test(p2[i] || "") || p1[i] === undefined || p2[i] === undefined);
            const pins = h("details", {class: "res-pins", ...(bad ? {open: ""} : {})}, h("summary", {}, bad ? "Pins: some don't match" : `Pins: ${count}, all matched`));
            const tbody = h("tbody");
            for(let i = 0; i < count; i++) {
                const a = p1[i] ?? "", b = p2[i] ?? "";
                tbody.append(h("tr", {class: NO_MATCH.test(a) || NO_MATCH.test(b) || !a || !b ? "res-diff" : ""}, h("td", {}, a), h("td", {}, b)));
            }
            pins.append(h("table", {class: "res-table"}, h("thead", {}, h("tr", {}, h("th", {}, n1), h("th", {}, n2))), tbody));
            section.append(pins);
        }
        return section;
    }
}

const resultWindow = new ResultWindow();

// ----- Files window: view and edit the project's files

class FilesWindow {
    constructor() {
        this.fw = null;
        this.path = null;
    }

    isOpen() {
        return Boolean(this.fw);
    }

    open() {
        if(this.fw) {
            this.fw.raise();
            return;
        }
        this.fw = new FloatingWindow(desktop, {
            title: "Files", x: 24, y: Math.min(360, desktop.clientHeight - 200), width: Math.min(560, desktop.clientWidth - 48),
            height: Math.min(320, desktop.clientHeight - 24), onClose: () => this.close(),
        });
        this.fw.body.innerHTML = '<div class="files-body"><ul class="files-list" role="listbox" aria-label="Project files"></ul>' +
            '<div class="files-edit"><div class="files-bar"><button type="button" data-act="save" title="Write the file (Ctrl+S)">Save</button>' +
            '<button type="button" data-act="run" title="Run it as a Tcl script (source)">Source</button>' +
            '<button type="button" data-act="new">New…</button><button type="button" data-act="download">Download</button><span></span></div>' +
            '<textarea spellcheck="false" aria-label="File contents"></textarea></div></div>';
        this.list = this.fw.body.querySelector(".files-list");
        paneResizer(this.list, {label: "Resize the file list", storageKey: "netgen-files-list-width"});
        this.text = this.fw.body.querySelector("textarea");
        this.label = this.fw.body.querySelector(".files-bar span");
        this.list.addEventListener("click", e => {
            const li = e.target.closest("li");
            if(li) {
                this.show(li.dataset.path);
            }
        });
        this.fw.body.querySelector(".files-bar").addEventListener("click", e => {
            const act = e.target.closest("button")?.dataset.act;
            if(act) {
                attempt(() => this[act]());
            }
        });
        this.text.addEventListener("keydown", e => {
            if(e.key === "s" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                attempt(() => this.save());
            }
        });
        this.refresh();
    }

    close() {
        this.fw?.remove();
        this.fw = null;
    }

    async refresh() {
        if(!this.fw || !project) {
            return;
        }
        let paths;
        try {
            paths = session.started ? (await session.listFiles()).map(f => f.path) : project.files.map(f => f.path);
        } catch(error) {
            return;              // netgen is restarting (Stop); the next refresh lists the files
        }
        paths.sort();
        this.list.textContent = "";
        for(const path of paths) {
            const li = document.createElement("li");
            li.dataset.path = path;
            li.textContent = path;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", String(path === this.path));
            this.list.appendChild(li);
        }
        if((!this.path || !paths.includes(this.path)) && paths.length) {
            this.show(paths.includes(project.compare.circuit2[0]) ? project.compare.circuit2[0] : paths[0]);
        }
    }

    async show(path) {
        this.path = path;
        let data;
        try {
            data = session.started ? await session.readFile(path) : project.files.find(f => f.path === path)?.data;
        } catch(error) {
            return;              // netgen is restarting, or the file is gone
        }
        const big = data && data.length > 2e6;
        this.text.value = !data ? "" : big ? `(${data.length} bytes: too big to show)` : decoder.decode(data);
        this.text.readOnly = big;
        this.label.textContent = path;
        for(const li of this.list.children) {
            li.setAttribute("aria-selected", String(li.dataset.path === path));
        }
    }

    async save() {
        if(!this.path || this.text.readOnly) {
            return;
        }
        const data = encoder.encode(this.text.value);
        await session.writeFile(this.path, data);
        const known = project.files.find(f => f.path === this.path);
        known ? (known.data = data) : project.files.push({path: this.path, data});
        print(`Wrote ${this.path}${NETLIST.test(this.path) ? " (Run LVS reads it again)" : ""}`, "info");
        compareWindow.refresh();
        scheduleSync();
    }

    async run() {
        if(this.path) {
            await this.save();
            await run(`source ${circuitArg([this.path, ""])}`);
        }
    }

    async new() {
        const v = await ask({title: "New file", fields: [{name: "path", label: "File name", value: "schematic.spice"}], ok: "Create"});
        if(v && v.path) {
            const path = cleanPath(v.path);
            await session.writeFile(path, new Uint8Array());
            project.files.push({path, data: new Uint8Array()});
            await this.refresh();
            await this.show(path);
            compareWindow.refresh();
            this.text.focus();
        }
    }

    async download() {
        if(this.path) {
            const data = session.started ? await session.readFile(this.path) : project.files.find(f => f.path === this.path)?.data;
            saveBlob(this.path.split("/").pop(), new Blob([data || new Uint8Array()]));
        }
    }
}

const filesWindow = new FilesWindow();

const windowsMenu = () => [
    {label: "Compare", checked: () => compareWindow.isOpen(), action: () => (compareWindow.isOpen() ? compareWindow.close() : compareWindow.open())},
    {label: "Result", checked: () => resultWindow.isOpen(), action: () => (resultWindow.isOpen() ? resultWindow.close() : resultWindow.open())},
    {label: "Files", checked: () => filesWindow.isOpen(), action: () => (filesWindow.isOpen() ? filesWindow.close() : filesWindow.open())},
];

// ----- Opening files

async function filesFromInput(fileList) {
    const files = [];
    for(const file of fileList) {
        files.push({path: cleanPath(file.webkitRelativePath || file.name), data: new Uint8Array(await file.arrayBuffer())});
    }
    return files;
}

async function openFiles(fileList, folderName) {
    try {
        const list = Array.from(fileList);
        if(list.length === 1 && isArchive(list[0].name)) {
            statusEl.textContent = `Reading ${list[0].name}…`;
            await loadProject(list[0].name, await readArchive(list[0].name, new Uint8Array(await list[0].arrayBuffer())));
            return;
        }
        const files = await filesFromInput(list);
        const netlist = files.find(f => NETLIST.test(f.path));
        const name = folderName || (netlist ? netlist.path.split("/").pop() : files[0]?.path.split("/")[0]) || "project";
        await loadProject(name, files);
    } catch(error) {
        print(String(error.message || error), "error");
        updateStatus();
    }
}

async function readEntry(entry, prefix) {
    if(entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return [{path: cleanPath(prefix + file.name), data: new Uint8Array(await file.arrayBuffer())}];
    }
    const reader = entry.createReader(), files = [];
    for(;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if(!batch.length) {
            break;
        }
        for(const child of batch) {
            files.push(...await readEntry(child, prefix + entry.name + "/"));
        }
    }
    return files;
}

$("#pick-files").addEventListener("change", event => {
    openFiles(event.target.files);
    event.target.value = "";
});
$("#pick-folder").addEventListener("change", event => {
    const first = event.target.files[0];
    openFiles(event.target.files, first ? first.webkitRelativePath.split("/")[0] : null);
    event.target.value = "";
});
document.addEventListener("dragover", event => {
    if(event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
        document.body.classList.add("dragging");
    }
});
document.addEventListener("dragleave", event => {
    if(!event.relatedTarget) {
        document.body.classList.remove("dragging");
    }
});
document.addEventListener("drop", async event => {
    if(!event.dataTransfer?.types?.includes("Files")) {
        return;
    }
    event.preventDefault();
    document.body.classList.remove("dragging");
    const entries = Array.from(event.dataTransfer.items || []).filter(i => i.kind === "file")
        .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if(entries.length === 1 && entries[0].isDirectory) {
        await attempt(async () => loadProject(entries[0].name, await readEntry(entries[0], "")));
        return;
    }
    await openFiles(event.dataTransfer.files);
});

// ----- Command line

const history = [];
let historyIndex = 0;

commandInput.addEventListener("keydown", event => {
    if(event.key === "Enter") {
        const line = commandInput.value.trim();
        commandInput.value = "";
        if(line) {
            if(history[history.length - 1] !== line) {
                history.push(line);
            }
            historyIndex = history.length;
            run(line);
        }
    } else if(event.key === "ArrowUp" && historyIndex > 0) {
        commandInput.value = history[--historyIndex];
        event.preventDefault();
    } else if(event.key === "ArrowDown") {
        historyIndex = Math.min(history.length, historyIndex + 1);
        commandInput.value = history[historyIndex] || "";
        event.preventDefault();
    }
});

$("#stop").addEventListener("click", () => session.stop());
$("#console-toggle").addEventListener("click", () => {
    const collapsed = $("#console").classList.toggle("collapsed");
    $("#console-toggle").setAttribute("aria-expanded", String(!collapsed));
});

// ----- Help

function showHelp(show) {
    $("#help").hidden = !show;
    $("#help-toggle").setAttribute("aria-expanded", String(show));
}
$("#help-toggle").addEventListener("click", () => showHelp($("#help").hidden));
document.addEventListener("pointerdown", event => {
    if(!$("#help").hidden && !event.target.closest("#help, #help-toggle")) {
        showHelp(false);
    }
}, true);

// ----- Keyboard focus
//
// The command line is home: controls used with the mouse give the keyboard
// back to it; controls used with the keyboard keep focus.  Escape first
// closes the help or a menu.

function home() {
    commandInput.focus({preventScroll: true});
}

document.addEventListener("keydown", event => {
    if(event.key !== "Escape" || event.defaultPrevented) {
        return;
    }
    if(!$("#help").hidden) {
        event.preventDefault();
        const fromKeyboard = document.activeElement?.closest?.("#help, #help-toggle");
        showHelp(false);
        fromKeyboard ? $("#help-toggle").focus() : home();
    } else if(document.querySelector(".mb-menu")) {
        closeMenus();
    }
});
document.addEventListener("click", event => {
    const control = event.target.closest("button, input[type=checkbox], label, #kofi");
    if(event.detail === 0 || !control || control.closest("dialog, .mb-menu, .mb-bar, #help, .files-bar, .command-row, .cmp-form, .res-body")) {
        return;
    }
    setTimeout(() => {
        const active = document.activeElement;
        if(active === document.body || active === control || control.contains(active)) {
            home();
        }
    }, 0);
});
setHomeFocus(home);

// ----- Start

$("#top-menus").appendChild(menuBar([
    ["Project", projectMenu],
    ["Examples", Object.entries(EXAMPLES).map(([name, example]) => ({label: example.label, action: () => attempt(() => loadExample(name))}))],
    ["Windows", windowsMenu],
    ["About", [
        {label: "netgen (Open Circuit Design)", href: "https://opencircuitdesign.com/netgen/"},
        {label: "netgen upstream source", href: "https://github.com/RTimothyEdwards/netgen"},
        "-",
        {label: "netgen license (GPL)", href: "https://github.com/NickOveracker/netgen/blob/wasm/Copying"},
        {label: "Tcl license (BSD-style)", href: "https://github.com/NickOveracker/netgen/blob/wasm/licenses/tcl-license.terms"},
        {label: "Emscripten runtime license (MIT)", href: "https://github.com/NickOveracker/netgen/blob/wasm/licenses/emscripten-LICENSE"},
        "-",
        {label: "This web app's source", href: "https://github.com/NickOveracker/netgen/tree/wasm"},
    ]],
], "Page menu", {onDone: home}));

// The announcement the GNU General Public License (paragraph 2c) asks an interactive
// program to show when it starts: copyright, no warranty, redistribution, and where the
// licence is.  The copyright line is netgen's own (src/base/netgen.h).
async function announce() {
    let version = "1.5";
    try {
        const response = await fetch(here("src/VERSION"));
        version = response.ok ? (await response.text()).trim() : version;
    } catch(error) {
        // Keep the short version
    }
    print(`netgen ${version}, Copyright 1990, 1991, 2002, 2004, 2005 Massimo A. Sivilotti, Caltech, and ` +
        "R. Timothy Edwards, MultiGiG, Inc.; changed for this WebAssembly build in 2026 (the changes are listed in the " +
        "source, About > This web app's source).", "info");
    print("netgen comes with ABSOLUTELY NO WARRANTY. It is free software: you may redistribute it under the terms of the " +
        "GNU General Public License; About > netgen license shows a copy.", "info");
}

async function start() {
    refreshRecent();
    await announce();
    resultWindow.open();
    const name = new URLSearchParams(location.search).get("example");
    await loadExample(EXAMPLES[name] ? name : DEFAULT_EXAMPLE);
    home();
}

start().catch(error => print(String(error.message || error), "error"));

// For tests and the browser console.
window.netgenApp = {run, runLvs, session, loadProject, loadExample, keepProject, openStore, BrowserStore, recentProjects,
    compareWindow, resultWindow, filesWindow, verdictOf,
    get project() {
        return project;
    },
    get result() {
        return lastResult;
    }};
