// SPDX-License-Identifier: GPL-2.0-or-later
// English and Japanese for the web apps (Magic, IRSIM, netgen, Loom): the pages' own text.
// What the programs print, commands, file names and what the user types stay as they are.
//
// Code is written in English.  Each module registers Japanese for its own strings
// (register({English: Japanese})), so a module shared between apps brings its translations
// with it; t(English, values) gives the text in the current language, with {name} filled
// from values.  Pages mark static text for applyStatic():
//   data-i18n                    the element's text (the English is the attribute or the text)
//   data-i18n-title, data-i18n-placeholder, data-i18n-aria-label   those attributes
// and give longer passages in both languages, as elements with data-only="en" and
// data-only="ja", of which the stylesheet shows the current language's.
//
// The language is kept per site (localStorage "stixu-lang"); ?lang=ja or ?lang=en in the
// address sets it, and without either the browser's own languages decide.

const KEY = "stixu-lang";
const LANGS = ["en", "ja"];

function initial() {
    // Asked for in the address (as the other apps do when they open this one): keep it, and
    // take it out of the address, so that a reload follows the toggle.
    const params = new URLSearchParams(location.search), asked = params.get("lang");
    if(LANGS.includes(asked)) {
        try {
            localStorage.setItem(KEY, asked);
            params.delete("lang");
            history.replaceState(history.state, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
        } catch(e) {
            // Keep it in the address
        }
        return asked;
    }
    try {
        const kept = localStorage.getItem(KEY);
        if(LANGS.includes(kept)) {
            return kept;
        }
    } catch(e) {
        // No storage: fall through
    }
    return (navigator.languages || [navigator.language]).some(l => /^ja\b/i.test(l || "")) ? "ja" : "en";
}

// Shared by every copy of this module on the page (Magic loads those of its submodules too).
const state = globalThis.__i18n || (globalThis.__i18n = {lang: initial(), ja: new Map(), listeners: new Set(), missing: new Set()});

export function register(table) {
    for(const [en, ja] of Object.entries(table)) {
        state.ja.set(en, ja);
    }
}

function fill(text, values) {
    return values ? text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)) : text;
}

// The text in the current language.  Untranslated text is noted (state.missing), for testing.
export function t(text, values) {
    if(state.lang === "ja") {
        const ja = state.ja.get(text);
        if(ja === undefined) {
            state.missing.add(text);
            return fill(text, values);
        }
        return fill(ja, values);
    }
    return fill(text, values);
}

// The same, for text that may be a name or already translated (menu labels, window titles):
// translated if a translation exists, otherwise shown as it is.
export function maybe(text) {
    return state.lang === "ja" && typeof text === "string" ? state.ja.get(text) ?? text : text;
}

export const lang = () => state.lang;

export function onLanguageChange(listener) {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
}

export function setLanguage(language) {
    if(!LANGS.includes(language) || language === state.lang) {
        return;
    }
    state.lang = language;
    try {
        localStorage.setItem(KEY, language);
    } catch(e) {
        // Not kept; still switched
    }
    applyStatic();
    for(const listener of state.listeners) {
        try {
            listener(language);
        } catch(error) {
            console.error(error);
        }
    }
}

const ATTRIBUTES = ["title", "placeholder", "aria-label"];

// Translate the marked text of a page (or part of one).
export function applyStatic(root = document) {
    addStyles();
    document.documentElement.lang = state.lang;
    for(const el of root.querySelectorAll("[data-i18n]")) {
        if(!el.dataset.i18n) {
            el.dataset.i18n = el.textContent.trim();
        }
        el.textContent = t(el.dataset.i18n);
    }
    for(const name of ATTRIBUTES) {
        for(const el of root.querySelectorAll(`[data-i18n-${name}]`)) {
            el.setAttribute(name, t(el.getAttribute(`data-i18n-${name}`)));
        }
    }
}

const STYLES = `
html[lang="ja"] [data-only="en"], html[lang="en"] [data-only="ja"] { display: none !important; }
html[lang="ja"] body { font-family: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP",
  "Yu Gothic UI", Meiryo, sans-serif; }
.i18n-toggle { white-space: nowrap; }
`;

function addStyles() {
    if(!document.getElementById("i18n-styles")) {
        const style = document.createElement("style");
        style.id = "i18n-styles";
        style.textContent = STYLES;
        document.head.appendChild(style);
    }
}

// A button that switches between the two languages, labelled with the other one.
export function languageButton() {
    addStyles();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "i18n-toggle";
    const label = () => {
        const other = state.lang === "ja" ? "en" : "ja";
        button.textContent = other === "ja" ? "日本語" : "English";
        button.lang = other;
        button.title = state.lang === "ja" ? "Switch to English" : "日本語に切り替える";
    };
    label();
    onLanguageChange(label);
    button.addEventListener("click", () => setLanguage(state.lang === "ja" ? "en" : "ja"));
    return button;
}

// For tests: the English strings asked for in Japanese without a translation.
export const untranslated = () => [...state.missing];
