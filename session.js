// SPDX-License-Identifier: GPL-2.0-or-later
// An interactive netgen session running in worker.js.
//
// Commands run one at a time, in order, and their output arrives while they
// run (onOutput).  netgen is deterministic, so a command that runs too long
// can be stopped by ending the worker and replaying the commands before it
// in a fresh one (stop()).  The same recovery follows "quit" or a crash.

import {t, register} from "./i18n.js";

// Its messages in Japanese (i18n.js).
register({
    "netgen is not running.": "netgen は実行されていません。",
    "netgen exited ({command}).": "netgen が終了しました（{command}）。",
    "netgen stopped: {why}.": "netgen が停止しました：{why}。",
    "{message} Restarting…": "{message}再起動しています…",
    "{message} Restarting and replaying 1 command…": "{message}再起動して、コマンド 1 個を再実行しています…",
    "{message} Restarting and replaying {n} commands…": "{message}再起動して、コマンド {n} 個を再実行しています…",
    'Back to the state before "{command}".': "「{command}」の前の状態に戻りました。",
    'Stopped "{command}".': "「{command}」を停止しました。",
});

export class Session {
    constructor({onOutput, onState}) {
        this.onOutput = onOutput;
        this.onState = onState || (() => {});
        this.worker = null;
        this.pending = new Map();
        this.nextId = 1;
        this.queue = Promise.resolve();
        this.log = [];               // Commands run so far, for replay
        this.files = [];             // The files the session started with, kept up to date
        this.busy = false;
        this.replaying = false;
        this.started = false;
    }

    spawn() {
        this.worker?.terminate();
        this.pending.clear();
        const worker = this.worker = new Worker(new URL("worker.js", import.meta.url));
        worker.onmessage = event => {
            const m = event.data;
            if(worker !== this.worker) {
                return;
            }
            if(m.type === "out") {
                if(!this.replaying) {
                    this.onOutput(m.text, m.error);
                }
            } else if(m.type === "ended") {
                this.endedEarly = m.error || "netgen exited";
            } else if(m.type === "reply") {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                if(p) {
                    m.error ? p.reject(new Error(m.error)) : p.resolve(m);
                }
            }
        };
        worker.onerror = event => {
            this.endedEarly = event.message || "the worker failed";
            for(const p of this.pending.values()) {
                p.reject(new Error(this.endedEarly));
            }
            this.pending.clear();
        };
    }

    request(message, transfer) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.worker.postMessage({...message, id}, transfer || []);
        });
    }

    // files: [{path, data: Uint8Array}] relative to the working folder (or absolute).
    async start(files) {
        this.files = files.map(f => ({path: f.path, data: f.data.slice()}));
        this.log = [];
        this.spawn();
        this.endedEarly = null;
        const reply = await this.request({type: "start", files: this.files});
        this.started = reply.ok;
        this.onState();
        return reply.ok;
    }

    // Evaluate one command line; resolves with {result, code, ms} once it has finished.
    run(script) {
        const job = this.queue.then(() => this.runNow(script));
        this.queue = job.catch(() => {});
        return job;
    }

    async runNow(script) {
        if(!this.worker || !this.started) {
            throw new Error(t("netgen is not running."));
        }
        this.busy = true;
        this.current = script;
        this.onState();
        try {
            const reply = await this.request({type: "eval", script});
            if(this.endedEarly) {
                const why = this.endedEarly;
                await this.recover(script, why === "netgen exited" ? t("netgen exited ({command}).", {command: script}) :
                    t("netgen stopped: {why}.", {why}));
                return {result: "", code: -1, ended: true};
            }
            this.log.push(script);
            return reply;
        } finally {
            this.busy = false;
            this.current = null;
            this.onState();
        }
    }

    // Start again with the same files and replay every command that finished.
    async recover(dropped, message) {
        const log = this.log.slice();
        const n = log.length;
        this.onOutput(t(!n ? "{message} Restarting…" : n === 1 ? "{message} Restarting and replaying 1 command…" :
            "{message} Restarting and replaying {n} commands…", {message, n}), true);
        this.replaying = true;
        try {
            this.spawn();
            this.endedEarly = null;
            await this.request({type: "start", files: this.files});
            for(const script of log) {
                await this.request({type: "eval", script});
            }
            this.log = log;
        } finally {
            this.replaying = false;
        }
        this.onOutput(t('Back to the state before "{command}".', {command: dropped}), false);
    }

    // Stop the command that is running (by restarting and replaying).
    async stop() {
        if(!this.busy) {
            return;
        }
        const script = this.current;
        for(const p of this.pending.values()) {
            p.reject(new Error("stopped"));
        }
        this.pending.clear();
        this.queue = Promise.resolve();
        await this.recover(script, t('Stopped "{command}".', {command: script}));
        this.busy = false;
        this.onState();
    }

    listFiles() {
        return this.request({type: "files"}).then(r => r.files);
    }

    readFile(path) {
        return this.request({type: "read", path}).then(r => r.data);
    }

    writeFile(path, data) {
        this.remember(path, data);
        return this.request({type: "write", path, data});
    }

    // Keep a file's latest contents for replays (files netgen wrote, or edits).
    remember(path, data) {
        const file = this.files.find(f => f.path === path);
        if(file) {
            file.data = data.slice();
        } else {
            this.files.push({path, data: data.slice()});
        }
    }
}
