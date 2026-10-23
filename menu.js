// SPDX-License-Identifier: GPL-2.0-or-later
// Drop-down menus for the layout windows' menu bars, like Tk's menubuttons.
//
// A menu is a list of items:
//   {label, action}                  a command
//   {label, checked: () => bool, action}   a check button
//   {label, disabled: true, title}   shown greyed out, with a reason
//   {label, href}                    a link, opened in a new tab
//   "-"                              a separator
// Items may also be a function returning such a list, so that a menu can be
// built afresh every time it opens (for lists of styles, windows and so on).
//
// Keyboard: Enter, space or Down opens a menu; arrows move; Left/Right switch
// to the neighbouring menu; Escape closes.
//
// Titles and labels are given in English and shown in the page's language (i18n.js), with
// the translations the apps register; labels without one (file names) are shown as they are.

import {maybe, onLanguageChange} from "./i18n.js";

const STYLES = `
.mb-bar { display: flex; flex-wrap: wrap; gap: 1px; }
.mb-bar, .mb-menu { -webkit-user-select: none; user-select: none; }
.mb-button { font: 12px system-ui, sans-serif; color: inherit; background: none; border: 1px solid transparent;
  border-radius: 4px; padding: 1px 7px; min-height: 22px; cursor: pointer; }
.mb-button:hover, .mb-button[aria-expanded="true"] { background: var(--head); border-color: var(--rule); }
.mb-out { margin-left: auto; padding-left: 12px; opacity: 0.7; }
.mb-menu { position: fixed; z-index: 2000000; min-width: 180px; max-height: 80vh; overflow: auto; margin: 0;
  padding: 4px 0; list-style: none; background: var(--panel); color: var(--fg); border: 1px solid var(--rule);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.25); font: 13px system-ui, sans-serif; }
.mb-item { display: flex; align-items: center; gap: 8px; padding: 4px 14px 4px 8px; cursor: default; white-space: nowrap; }
.mb-item:focus { outline: none; background: var(--accent); color: #fff; }
.mb-item[aria-disabled="true"] { color: var(--muted); }
.mb-item[aria-disabled="true"]:focus { background: var(--rule); color: var(--muted); }
.mb-check { width: 1em; text-align: center; }
.mb-sep { height: 1px; margin: 4px 0; background: var(--rule); }
`;

// The open menu is shared by every copy of this module on the page, so that only one menu is ever open.
const state = globalThis.__menus || (globalThis.__menus = {open: null, listening: false});

function addStyles() {
    if(!document.getElementById("mb-styles")) {
        const style = document.createElement("style");
        style.id = "mb-styles";
        style.textContent = STYLES;
        document.head.appendChild(style);
    }
}

export function closeMenus() {
    if(state.open) {
        state.open.list.remove();
        state.open.button.setAttribute("aria-expanded", "false");
        state.open = null;
    }
}

if(!state.listening) {
    state.listening = true;
    document.addEventListener("pointerdown", event => {
        if(state.open && !state.open.list.contains(event.target) && event.target !== state.open.button) {
            closeMenus();
        }
    }, true);
    window.addEventListener("blur", closeMenus);
    document.addEventListener("keydown", event => {
        if(event.key === "Escape" && state.open) {
            const {button, done} = state.open;
            closeMenus();
            if(done) {
                done();
            } else {
                button.focus({preventScroll: true});
            }
        }
    });
    window.addEventListener("resize", closeMenus);
}

// A menu bar: menus is [[title, items], ...].  Returns the bar element.
// After a choice made with the mouse, options.onDone() runs instead of focus
// going back to the menu button, so that (for example) the layout window gets
// the keyboard again; a choice made with the keyboard keeps focus on the button.
export function menuBar(menus, label, options = {}) {
    addStyles();
    const bar = document.createElement("div");
    bar.className = "mb-bar";
    bar.setAttribute("role", "menubar");
    const buttons = menus.map(([title, items]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mb-button";
        button.dataset.title = title;
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", event => {
            if(state.open && state.open.button === button) {
                // A menu that opened as the pointer slid onto it stays open when clicked.
                if(state.open.byHover) {
                    state.open.byHover = false;
                } else {
                    const done = state.open.done;
                    closeMenus();
                    // Closed with the mouse: give the keyboard back, as after a choice.
                    if(event.detail > 0 && options.onDone) {
                        options.onDone();
                    } else if(done) {
                        done();
                    }
                }
            } else {
                open(button, items, false, event.detail > 0);
            }
        });
        button.addEventListener("pointerenter", () => {
            if(state.open && state.open.button !== button && bar.contains(state.open.button)) {
                open(button, items, false, true);
                state.open.byHover = true;
            }
        });
        button.addEventListener("keydown", event => {
            if(event.key === "ArrowDown") {
                event.preventDefault();
                open(button, items, true);
            }
        });
        bar.appendChild(button);
        return {button, items};
    });
    const translate = () => {
        bar.setAttribute("aria-label", maybe(label));
        for(const {button} of buttons) {
            button.textContent = maybe(button.dataset.title);
        }
    };
    translate();
    // Follow the language until the bar has been on the page and left it.
    let placed = false;
    const stop = onLanguageChange(() => {
        if(bar.isConnected || !placed) {
            placed = placed || bar.isConnected;
            translate();
        } else {
            stop();
        }
    });

    function neighbour(button, step) {
        const i = buttons.findIndex(b => b.button === button);
        const next = buttons[(i + step + buttons.length) % buttons.length];
        open(next.button, next.items, true);
    }

    function open(button, items, focusFirst, byPointer) {
        closeMenus();
        const list = document.createElement("ul");
        list.className = "mb-menu";
        list.setAttribute("role", "menu");
        list.setAttribute("aria-label", button.textContent);
        for(const item of typeof items === "function" ? items() : items) {
            const li = document.createElement("li");
            if(item === "-") {
                li.className = "mb-sep";
                li.setAttribute("role", "separator");
                list.appendChild(li);
                continue;
            }
            li.className = "mb-item";
            li.tabIndex = -1;
            const checked = item.checked ? Boolean(item.checked()) : null;
            li.setAttribute("role", checked === null ? "menuitem" : "menuitemcheckbox");
            if(checked !== null) {
                li.setAttribute("aria-checked", String(checked));
            }
            li.innerHTML = '<span class="mb-check" aria-hidden="true"></span><span></span>';
            li.firstChild.textContent = checked ? "✓" : "";
            li.lastChild.textContent = maybe(item.label);
            if(item.href) {
                li.insertAdjacentHTML("beforeend", '<span class="mb-out" aria-hidden="true">↗</span>');
            }
            if(item.disabled) {
                li.setAttribute("aria-disabled", "true");
            }
            if(item.title) {
                li.title = maybe(item.title);
            }
            const choose = byKeyboard => {
                if(item.disabled) {
                    return;
                }
                closeMenus();
                if(byKeyboard || !options.onDone) {
                    button.focus({preventScroll: true});
                }
                if(item.href) {
                    window.open(item.href, "_blank", "noopener");
                } else {
                    item.action();
                }
                if(!byKeyboard && options.onDone) {
                    options.onDone();
                }
            };
            li.addEventListener("click", () => choose(false));
            li.addEventListener("pointermove", () => li.focus({preventScroll: true}));
            li.addEventListener("keydown", event => {
                if(event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(true);
                }
            });
            list.appendChild(li);
        }
        list.addEventListener("keydown", event => {
            const items = [...list.querySelectorAll(".mb-item")];
            const i = items.indexOf(document.activeElement);
            if(event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                items[(i + step + items.length) % items.length]?.focus();
            } else if(event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                neighbour(button, event.key === "ArrowRight" ? 1 : -1);
            } else if(event.key === "Tab") {
                closeMenus();
            }
        });
        document.body.appendChild(list);
        const r = button.getBoundingClientRect();
        const width = list.offsetWidth, height = list.offsetHeight;
        list.style.left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4)) + "px";
        list.style.top = (r.bottom + height + 4 <= window.innerHeight ? r.bottom + 2 : Math.max(4, r.top - height - 2)) + "px";
        button.setAttribute("aria-expanded", "true");
        state.open = {button, list, byHover: false, done: byPointer ? options.onDone : null};
        if(focusFirst) {
            list.querySelector(".mb-item")?.focus();
        }
    }

    return bar;
}
