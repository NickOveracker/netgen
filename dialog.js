// SPDX-License-Identifier: GPL-2.0-or-later
// Modal form dialogs (the web counterpart of the Tcl wrapper's prompt
// dialogs).  ask({title, fields, ok}) resolves to {name: value, ...}, or
// null when cancelled.  A field is {name, label, value, options?, list?}:
// "options" makes a drop-down, "list" offers suggestions while typing.
// Text is given in English and shown in the page's language (i18n.js).

import {t, maybe, register} from "./i18n.js";

register({"Cancel": "キャンセル", "OK": "OK"});

const STYLES = `
.dlg { border: 1px solid var(--rule); border-radius: 10px; padding: 0; background: var(--panel); color: var(--fg);
  box-shadow: 0 12px 40px rgba(0,0,0,.3); width: min(420px, calc(100vw - 32px)); }
.dlg::backdrop { background: rgba(0,0,0,.25); }
.dlg form { display: grid; gap: 10px; padding: 14px 16px; }
.dlg h2 { font-size: 15px; margin: 0; }
.dlg p { margin: 0; color: var(--muted); font-size: 13px; }
.dlg label { display: grid; gap: 3px; font-size: 13px; }
.dlg input, .dlg select { font: 13px var(--mono); color: inherit; background: var(--log-bg); border: 1px solid var(--rule);
  border-radius: 5px; padding: 4px 6px; }
.dlg .dlg-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
`;

let counter = 0;
let homeFocus = null;

// Where focus goes when a dialog closes and whatever had focus before is gone.
export function setHomeFocus(fn) {
    homeFocus = fn;
}

export function ask({title, message, fields = [], ok = "OK"}) {
    if(!document.getElementById("dlg-styles")) {
        const style = document.createElement("style");
        style.id = "dlg-styles";
        style.textContent = STYLES;
        document.head.appendChild(style);
    }
    const dialog = document.createElement("dialog");
    dialog.className = "dlg";
    const form = document.createElement("form");
    form.method = "dialog";
    const heading = document.createElement("h2");
    heading.textContent = maybe(title);
    form.appendChild(heading);
    if(message) {
        const p = document.createElement("p");
        p.textContent = maybe(message);
        form.appendChild(p);
    }
    const inputs = {};
    for(const field of fields) {
        const label = document.createElement("label");
        label.textContent = maybe(field.label);
        let input;
        if(field.options) {
            input = document.createElement("select");
            for(const option of field.options) {
                const [value, text] = Array.isArray(option) ? option : [option, option];
                input.add(new Option(maybe(text), value));
            }
        } else {
            input = document.createElement("input");
            input.autocomplete = "off";
            input.spellcheck = false;
            if(field.list && field.list.length) {
                const list = document.createElement("datalist");
                list.id = "dlg-list-" + ++counter;
                for(const value of field.list) {
                    list.appendChild(new Option(value));
                }
                form.appendChild(list);
                input.setAttribute("list", list.id);
            }
        }
        input.name = field.name;
        if(field.value !== undefined) {
            input.value = field.value;
        }
        label.appendChild(input);
        form.appendChild(label);
        inputs[field.name] = input;
    }
    const buttons = document.createElement("div");
    buttons.className = "dlg-buttons";
    buttons.innerHTML = '<button type="button" value="cancel"></button><button type="submit" value="ok"></button>';
    buttons.firstChild.textContent = t("Cancel");
    buttons.lastChild.textContent = maybe(ok);
    form.appendChild(buttons);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const previous = document.activeElement;

    return new Promise(resolve => {
        buttons.firstChild.addEventListener("click", () => dialog.close("cancel"));
        dialog.addEventListener("close", () => {
            const values = {};
            for(const [name, input] of Object.entries(inputs)) {
                values[name] = input.value.trim();
            }
            dialog.remove();
            if(previous && previous.isConnected && previous !== document.body) {
                previous.focus({preventScroll: true});
            } else if(homeFocus) {
                homeFocus();
            }
            resolve(dialog.returnValue === "ok" ? values : null);
        });
        form.addEventListener("submit", event => {
            event.preventDefault();
            dialog.close("ok");
        });
        dialog.showModal();
        const first = form.querySelector("input, select");
        first?.focus();
        first?.select?.();
    });
}
