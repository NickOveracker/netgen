// SPDX-License-Identifier: GPL-2.0-or-later
// Passing a project from one of the web apps (Magic, IRSIM, netgen) to another, in a new tab.
// The sender opens the other app with ?from=<app>; the new tab says it is ready; the sender
// posts it the project, which never leaves the browser.  Only the apps' own sites take part:
// their stixu.io subdomains, or the page's own origin (the apps served together, as Magic
// serves the other two from its submodules).

import {t, lang, register} from "./i18n.js";

register({
    "The browser blocked the new tab: allow pop-ups for this site, then try again.":
        "ブラウザーが新しいタブをブロックしました。このサイトのポップアップを許可してから、もう一度お試しください。",
    "{host} didn't answer.": "{host} から応答がありませんでした。",
});

const SITES = {magic: "https://magic.stixu.io", irsim: "https://irsim.stixu.io", netgen: "https://netgen.stixu.io"};
const READY = "stixu-ready", PROJECT = "stixu-project";
const trusted = origin => origin === location.origin || Object.values(SITES).includes(origin);

// The other app's address: its own site when this page is on one of the stixu.io sites,
// otherwise `local` (for example Magic's submodule copy, irsim/ next to it).
export function appUrl(app, local) {
    return location.hostname.endsWith(".stixu.io") ? new URL(SITES[app] + "/") : new URL(local);
}

// Open the app at `url` in a new tab and send it `project` ({name, files: [{path, data}], ...}).
// Call it from a click (or another user action), or the browser blocks the tab.
export function sendProject(url, from, project, {timeout = 60000} = {}) {
    url = new URL(url);
    url.searchParams.set("from", from);
    // The other app opens in this page's language.
    url.searchParams.set("lang", lang());
    const target = window.open(url, "_blank");
    if(!target) {
        return Promise.reject(new Error(t("The browser blocked the new tab: allow pop-ups for this site, then try again.")));
    }
    return new Promise((resolve, reject) => {
        const done = () => {
            clearTimeout(timer);
            window.removeEventListener("message", listen);
        };
        const timer = setTimeout(() => {
            done();
            reject(new Error(t("{host} didn't answer.", {host: url.host})));
        }, timeout);
        const listen = event => {
            if(event.source !== target || !trusted(event.origin) || event.data?.type !== READY) {
                return;
            }
            done();
            target.postMessage({type: PROJECT, project}, event.origin);
            resolve();
        };
        window.addEventListener("message", listen);
    });
}

// In the receiving app: if another app opened this page to pass it a project (?from=<app>),
// wait for the project and return it, along with the sender's name; otherwise return null.
export function receiveProject({timeout = 10000} = {}) {
    const params = new URLSearchParams(location.search), from = params.get("from"), opener = window.opener;
    if(!from) {
        return Promise.resolve(null);
    }
    // A reload shouldn't wait for the project again.
    params.delete("from");
    history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
    if(!opener) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const done = value => {
            clearTimeout(timer);
            window.removeEventListener("message", listen);
            resolve(value);
        };
        const timer = setTimeout(() => done(null), timeout);
        const listen = event => {
            if(event.source === opener && trusted(event.origin) && event.data?.type === PROJECT) {
                done({from, ...event.data.project});
            }
        };
        window.addEventListener("message", listen);
        // Nothing private in this message, so any origin may see it; the reply is checked above.
        opener.postMessage({type: READY}, "*");
    });
}
