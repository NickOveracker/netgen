// SPDX-License-Identifier: GPL-2.0-or-later
// LVS with netgen, for pages that run it in a Session (session.js): building
// the lvs command, running it and reading its verdict (LvsRunner), and the
// Result window that shows what netgen found.  Used by the netgen web app,
// and by the Magic web app's lvs command (from its netgen submodule).

import {FloatingWindow} from "./floating-window.js";

const STYLES = `
.res-body { --pass: #1e6b3a; --pass-bg: #e3f3e8; --warn: #8a5a00; --warn-bg: #fff2d6; --fail: #b3261e; --fail-bg: #fbe5e3;
  overflow: auto; padding: 10px 12px; font-size: 13px; }
.res-empty { color: var(--muted); }
.res-verdict { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 8px; border: 1px solid; }
.res-verdict strong { font-size: 15px; }
.res-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; color: #fff;
  font-weight: 700; font-size: 16px; }
.res-pass { background: var(--pass-bg); border-color: var(--pass); }
.res-pass .res-icon { background: var(--pass); }
.res-warn { background: var(--warn-bg); border-color: var(--warn); }
.res-warn .res-icon { background: var(--warn); }
.res-fail { background: var(--fail-bg); border-color: var(--fail); }
.res-fail .res-icon { background: var(--fail); }
@media (prefers-color-scheme: dark) {
  .res-body { --pass: #8fd3a4; --pass-bg: #1d3325; --warn: #ffc94d; --warn-bg: #3a3018; --fail: #f2948c; --fail-bg: #3e2220; }
  .res-icon { color: #111; }
}
.res-sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.res-actions { display: flex; gap: 6px; margin: 8px 0; }
.res-actions button { font-size: 12px; min-height: 24px; padding: 1px 8px; }
.res-cell h3 { font-size: 14px; margin: 14px 0 6px; overflow-wrap: anywhere; }
.res-cell h4 { font-size: 13px; margin: 12px 0 4px; }
.res-table { border-collapse: collapse; font: 12px var(--mono); margin: 2px 0; }
.res-table th, .res-table td { border: 1px solid var(--rule); padding: 2px 8px; text-align: left; vertical-align: top; }
.res-table th { font-family: system-ui, sans-serif; font-weight: 600; background: var(--head); }
.res-table td + td { text-align: right; }
.res-props td + td, .res-pins td + td { text-align: left; }
.res-diff td { background: var(--fail-bg); }
.res-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 4px 0; padding-bottom: 6px; border-bottom: 1px dashed var(--rule); }
.res-frag { font: 12px var(--mono); margin-bottom: 4px; }
.res-frag strong { overflow-wrap: anywhere; }
.res-frag div { color: var(--muted); padding-left: 10px; }
.res-none strong { color: var(--fail); }
.res-pins { margin: 10px 0 0; }
.res-pins summary, .res-report summary { cursor: pointer; font-weight: 600; font-size: 13px; }
.res-report { margin-top: 14px; }
.res-report pre { font: 11px/1.4 var(--mono); background: var(--log-bg); border: 1px solid var(--rule); border-radius: 6px;
  padding: 8px; overflow: auto; max-height: 60vh; }
`;

function addStyles() {
    if(!document.getElementById("lvs-styles")) {
        const style = document.createElement("style");
        style.id = "lvs-styles";
        style.textContent = STYLES;
        document.head.appendChild(style);
    }
}

const decoder = new TextDecoder();

// ----- The comparison

export function circuitArg([file, cell]) {
    const brace = s => (/^[^\s{}\\"[\]$;]+$/.test(s) ? s : `{${s}}`);
    return cell ? `{${brace(file)} ${brace(cell)}}` : brace(file);
}

export function lvsCommand(compare) {
    const setup = compare.setup || "nosetup";
    return `lvs ${circuitArg(compare.circuit1)} ${circuitArg(compare.circuit2)} ${setup} comp.out -json` +
        (compare.blackbox ? " -blackbox" : "");
}

// netgen's verdict, from its report: the "Final result" and anything before
// it that says the netlists don't match.
export function verdictOf(report) {
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

// Runs "lvs" through a page's command runner and reads the report and JSON it
// writes.  host: {run(command, {echo}) -> {result, code, ended}, readFile(path) -> Uint8Array}.
// The page passes the error lines netgen prints to noteError(), so that a run
// without a report can say why.
export class LvsRunner {
    constructor(host) {
        this.host = host;
        this.errors = null;
    }

    noteError(text) {
        if(this.errors && text.trim()) {
            this.errors.push(text.trim());
        }
    }

    // compare: {circuit1: [file, cell], circuit2: [file, cell], setup, blackbox}.  Resolves with the
    // result ({final, kind, short, report, json, command, ms, compare}), or null if netgen stopped.
    async compare(compare) {
        // A fresh database each time, so edited files are read again, and no
        // report from an earlier run that could be taken for this one's.
        await this.host.run("reinitialize; file delete -force comp.out comp.json", {echo: false});
        const command = lvsCommand(compare);
        const t0 = performance.now();
        this.errors = [];
        let reply;
        try {
            reply = await this.host.run(command, {echo: true});
        } finally {
            this.lastErrors = this.errors;
            this.errors = null;
        }
        if(!reply || reply.ended) {
            return null;
        }
        let report = "", json = null;
        try {
            report = decoder.decode(await this.host.readFile("comp.out"));
        } catch(e) {
            // No report: netgen stopped early; the console says why.
        }
        try {
            json = JSON.parse(decoder.decode(await this.host.readFile("comp.json")));
        } catch(e) {
            json = null;
        }
        const errors = this.lastErrors;
        const verdict = report ? verdictOf(report) :
            {final: `netgen wrote no report: ${(reply.result || errors[errors.length - 1] || "see the console").trim()}`, kind: "fail",
                short: "no result"};
        return {...verdict, report, json, command, ms: performance.now() - t0, compare: structuredClone(compare)};
    }
}

// ----- The Result window

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

// The Result window.  host: {desktop, saveBlob, result() (the latest result, or null),
// emptyText() (what to say when there is none)}.
export class ResultWindow {
    constructor(host) {
        this.host = host;
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
        addStyles();
        const desktop = this.host.desktop;
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
        const r = this.host.result();
        if(!r) {
            body.append(h("p", {class: "res-empty"}, this.host.emptyText()));
            return;
        }
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
                this.host.saveBlob("comp.out", new Blob([r.report], {type: "text/plain"}));
            } else if(act === "json") {
                this.host.saveBlob("comp.json", new Blob([JSON.stringify(r.json, null, 1)], {type: "application/json"}));
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
