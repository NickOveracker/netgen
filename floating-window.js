// SPDX-License-Identifier: GPL-2.0-or-later
// Floating windows on a desktop element (shared by the Magic, IRSIM and netgen web apps): drag by the title bar, resize from
// any edge or corner, collapse to the title bar, close.
// Clicking a window brings it to the front.  With the title bar focused,
// arrow keys move the window and Shift+arrow keys resize it.
//
// Geometry is in pixels relative to the desktop.  onChange(geometry) runs
// after every move or resize, so the owner can follow along.
//
// topEdgeResizer() makes a panel docked below the desktop (the console)
// resizable from its top edge, and paneResizer() a side pane (the Files
// window's list) resizable from its right edge.

import {t, maybe, register, onLanguageChange} from "./i18n.js";

register({"Close": "閉じる", "Expand": "展開", "Collapse": "折りたたむ", "Resize": "サイズを変更"});

const STYLES = `
.fw-window { position: absolute; display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--panel); color: var(--fg); border: 1px solid var(--rule);
  border-radius: 8px; box-shadow: 0 6px 22px rgba(0,0,0,.22); overflow: hidden; }
.fw-header { display: flex; align-items: center; gap: 4px; height: 30px; box-sizing: border-box;
  padding: 0 4px 0 10px; cursor: move; user-select: none; touch-action: none;
  background: var(--head); border-bottom: 1px solid var(--rule); font-size: 13px; font-weight: 600; }
.fw-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.fw-title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fw-button { border: 0; background: none; color: inherit; font: inherit; width: 26px; height: 24px;
  border-radius: 5px; cursor: pointer; }
.fw-button:hover, .fw-button:focus-visible { background: var(--rule); }
.fw-body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.fw-window.fw-collapsed .fw-body, .fw-window.fw-collapsed .fw-resize { display: none; }
.fw-window.fw-collapsed .fw-header { border-bottom: 0; }
.fw-resize { position: absolute; touch-action: none; z-index: 1; }
.fw-n, .fw-s { left: 0; width: 100%; height: 6px; cursor: ns-resize; }
.fw-e, .fw-w { top: 0; height: 100%; width: 6px; cursor: ew-resize; }
.fw-n { top: 0; } .fw-s { bottom: 0; } .fw-e { right: 0; } .fw-w { left: 0; }
.fw-ne, .fw-nw, .fw-se, .fw-sw { width: 12px; height: 12px; }
.fw-ne { top: 0; right: 0; cursor: nesw-resize; } .fw-sw { bottom: 0; left: 0; cursor: nesw-resize; }
.fw-nw { top: 0; left: 0; cursor: nwse-resize; } .fw-se { bottom: 0; right: 0; cursor: nwse-resize; }
.fw-grip { position: absolute; left: 0; right: 0; top: 0; height: 6px; cursor: ns-resize; touch-action: none;
  z-index: 1; }
.fw-grip:focus-visible { outline: none; background: var(--accent); }
.collapsed > .fw-grip { display: none; }
.fw-vgrip { flex: none; width: 5px; margin: 0 -2px; cursor: col-resize; touch-action: none; z-index: 1;
  border-left: 1px solid var(--rule); background-clip: content-box; }
.fw-vgrip:hover, .fw-vgrip:focus-visible { outline: none; background: var(--accent); }
`;

function addStyles() {
    if(!document.getElementById("fw-styles")) {
        const style = document.createElement("style");
        style.id = "fw-styles";
        style.textContent = STYLES;
        document.head.appendChild(style);
    }
}

export const HEADER_HEIGHT = 30;

// Stacking order is shared by every copy of this module on the page (the Magic
// app and the IRSIM app each have one).
const shared = globalThis.__floatingWindows || (globalThis.__floatingWindows = {topZ: 10});
const TOPMOST = 100000;

export class FloatingWindow {
    constructor(desktop, options) {
        addStyles();
        this.desktop = desktop;
        this.onClose = options.onClose || null;
        this.onChange = options.onChange || null;
        this.onCollapse = options.onCollapse || null;
        // Tool windows (the managers) stay above the ordinary windows, like separate top-level windows.
        this.topmost = Boolean(options.topmost);
        this.min = {width: 160, height: 100};

        const el = this.element = document.createElement("section");
        el.className = "fw-window";
        el.innerHTML = '<header class="fw-header" tabindex="0"><span class="fw-title"></span>' +
            '<button type="button" class="fw-button fw-collapse"></button>' +
            '<button type="button" class="fw-button fw-close">✕</button></header>' +
            '<div class="fw-body"></div>' +
            ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map(edge =>
                `<div class="fw-resize fw-${edge}" data-edge="${edge}"></div>`).join("");
        this.header = el.querySelector(".fw-header");
        this.body = el.querySelector(".fw-body");
        this.setTitle(options.title || "");
        desktop.appendChild(el);
        // Titles are given in English and shown in the page's language.
        const stop = onLanguageChange(() => (el.isConnected ? this.translate() : stop()));

        this.geometry = {x: options.x, y: options.y, width: options.width, height: options.height,
            collapsed: false};
        this.apply();
        this.listen();
        this.raise();
    }

    setTitle(title) {
        this.title = title;
        this.translate();
    }

    translate() {
        this.element.querySelector(".fw-title").textContent = maybe(this.title);
        this.element.setAttribute("aria-label", maybe(this.title));
        const close = this.element.querySelector(".fw-close");
        close.title = t("Close");
        close.setAttribute("aria-label", t("Close"));
        if(this.geometry) {
            this.apply();
        }
    }

    raise() {
        this.element.style.zIndex = ++shared.topZ + (this.topmost ? TOPMOST : 0);
    }

    lower() {
        let lowest = Infinity;
        for(const other of this.desktop.querySelectorAll(".fw-window")) {
            lowest = Math.min(lowest, Number(other.style.zIndex) || 0);
        }
        this.element.style.zIndex = lowest - 1;
    }

    remove() {
        this.element.remove();
    }

    setCollapsed(collapsed) {
        this.geometry.collapsed = collapsed;
        this.apply();
        if(this.onCollapse) {
            this.onCollapse(collapsed);
        }
    }

    // Keep part of the title bar inside the desktop, and the window no smaller than its minimum.
    clamp() {
        const g = this.geometry, dw = this.desktop.clientWidth, dh = this.desktop.clientHeight;
        g.width = Math.max(this.min.width, Math.round(g.width));
        g.height = Math.max(this.min.height, Math.round(g.height));
        g.x = Math.round(Math.min(Math.max(g.x, 60 - g.width), dw - 60));
        g.y = Math.round(Math.min(Math.max(g.y, 0), Math.max(0, dh - HEADER_HEIGHT)));
    }

    // Set the geometry without telling the owner (used when the owner moved the window).
    setGeometry(x, y, width, height) {
        Object.assign(this.geometry, {x, y, width, height});
        this.apply();
    }

    apply() {
        this.clamp();
        const g = this.geometry, el = this.element;
        el.style.left = g.x + "px";
        el.style.top = g.y + "px";
        el.style.width = g.width + "px";
        el.style.height = g.collapsed ? "auto" : g.height + "px";
        el.classList.toggle("fw-collapsed", g.collapsed);
        const button = el.querySelector(".fw-collapse");
        button.textContent = g.collapsed ? "▸" : "▾";
        button.setAttribute("aria-label", t(g.collapsed ? "Expand" : "Collapse"));
        button.title = button.getAttribute("aria-label");
        button.setAttribute("aria-expanded", String(!g.collapsed));
    }

    changed() {
        if(this.onChange) {
            this.onChange(this.geometry);
        }
    }

    listen() {
        const el = this.element;
        el.addEventListener("pointerdown", () => this.raise(), true);
        el.querySelector(".fw-close").onclick = () => this.onClose ? this.onClose() : this.remove();
        el.querySelector(".fw-collapse").onclick = () => this.setCollapsed(!this.geometry.collapsed);
        this.header.addEventListener("dblclick", event => {
            if(!event.target.closest(".fw-button")) {
                this.setCollapsed(!this.geometry.collapsed);
            }
        });

        this.drag(this.header, (start, dx, dy) => {
            this.geometry.x = start.x + dx;
            this.geometry.y = start.y + dy;
        }, event => !event.target.closest(".fw-button"));
        for(const handle of el.querySelectorAll(".fw-resize")) {
            const edge = handle.dataset.edge;
            this.drag(handle, (start, dx, dy) => {
                const g = this.geometry;
                if(edge.includes("e")) {
                    g.width = start.width + dx;
                }
                if(edge.includes("s")) {
                    g.height = start.height + dy;
                }
                // The left and top edges move while the opposite edge stays put, down to the
                // minimum size and, for the top, no higher than the top of the desktop.
                if(edge.includes("w")) {
                    g.width = Math.max(this.min.width, start.width - dx);
                    g.x = start.x + start.width - g.width;
                }
                if(edge.includes("n")) {
                    const bottom = start.y + start.height;
                    g.y = Math.max(0, Math.min(start.y + dy, bottom - this.min.height));
                    g.height = bottom - g.y;
                }
            });
        }

        this.header.addEventListener("keydown", event => {
            const steps = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
            const step = steps[event.key];
            if(!step || event.target !== this.header) {
                return;
            }
            event.preventDefault();
            const g = this.geometry, amount = event.altKey ? 1 : 16;
            if(event.shiftKey) {
                g.width += step[0] * amount;
                g.height += step[1] * amount;
            } else {
                g.x += step[0] * amount;
                g.y += step[1] * amount;
            }
            this.apply();
            this.changed();
        });
    }

    // Pointer dragging on a handle: update(startGeometry, dx, dy) on each move.
    // The owner hears about the change when the drag ends.
    drag(handle, update, accept) {
        let start = null;
        handle.addEventListener("pointerdown", event => {
            if(event.button !== 0 || (accept && !accept(event))) {
                return;
            }
            event.preventDefault();
            start = {px: event.clientX, py: event.clientY, ...this.geometry};
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", event => {
            if(start) {
                update(start, event.clientX - start.px, event.clientY - start.py);
                this.apply();
            }
        });
        const stop = () => {
            if(start) {
                start = null;
                this.changed();
            }
        };
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
    }
}

// A panel docked below the desktop, resized by dragging its top edge, or with the edge
// focused, with the up and down arrow keys.  The panel keeps at least min pixels, and the
// desktop above it at least minAbove.
export function topEdgeResizer(panel, desktop, {min = 34, minAbove = 120, label = "Resize"} = {}) {
    addStyles();
    if(getComputedStyle(panel).position === "static") {
        panel.style.position = "relative";
    }
    const grip = document.createElement("div");
    grip.className = "fw-grip";
    grip.tabIndex = 0;
    grip.title = maybe(label);
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", maybe(label));
    onLanguageChange(() => {
        grip.title = maybe(label);
        grip.setAttribute("aria-label", maybe(label));
    });
    panel.prepend(grip);
    const setHeight = height => {
        const max = Math.max(min, panel.offsetHeight + desktop.clientHeight - minAbove);
        panel.style.height = Math.round(Math.min(Math.max(height, min), max)) + "px";
    };
    let start = null;
    grip.addEventListener("pointerdown", event => {
        if(event.button === 0) {
            event.preventDefault();
            start = {y: event.clientY, height: panel.offsetHeight};
            grip.setPointerCapture(event.pointerId);
        }
    });
    grip.addEventListener("pointermove", event => {
        if(start) {
            setHeight(start.height - (event.clientY - start.y));
        }
    });
    const stop = () => {
        start = null;
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
    grip.addEventListener("keydown", event => {
        const step = {ArrowUp: 1, ArrowDown: -1}[event.key];
        if(step) {
            event.preventDefault();
            setHeight(panel.offsetHeight + step * (event.altKey ? 1 : 16));
        }
    });
    return grip;
}

// A pane beside other content in a flex row, resized by dragging its right edge, or with
// the edge focused, with the left and right arrow keys.  The pane keeps at least min pixels
// and leaves at least minRest to the rest of the row.  With a storageKey, the width is
// remembered in the browser.
export function paneResizer(pane, {min = 80, minRest = 160, label = "Resize", storageKey = null} = {}) {
    addStyles();
    const grip = document.createElement("div");
    grip.className = "fw-vgrip";
    grip.tabIndex = 0;
    grip.title = maybe(label);
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "vertical");
    grip.setAttribute("aria-label", maybe(label));
    onLanguageChange(() => {
        grip.title = maybe(label);
        grip.setAttribute("aria-label", maybe(label));
    });
    pane.after(grip);
    const setWidth = (width, remember) => {
        const row = pane.parentElement;
        const max = Math.max(min, row.clientWidth - minRest);
        pane.style.width = Math.round(Math.min(Math.max(width, min), max)) + "px";
        pane.style.flex = "none";
        if(remember && storageKey) {
            try {
                localStorage.setItem(storageKey, String(pane.offsetWidth));
            } catch(e) {
                // Storage unavailable: the width just isn't remembered
            }
        }
    };
    if(storageKey) {
        try {
            const saved = Number(localStorage.getItem(storageKey));
            if(saved > 0) {
                requestAnimationFrame(() => setWidth(saved, false));
            }
        } catch(e) {
            // Storage unavailable
        }
    }
    let start = null;
    grip.addEventListener("pointerdown", event => {
        if(event.button === 0) {
            event.preventDefault();
            start = {x: event.clientX, width: pane.offsetWidth};
            grip.setPointerCapture(event.pointerId);
        }
    });
    grip.addEventListener("pointermove", event => {
        if(start) {
            setWidth(start.width + event.clientX - start.x, false);
        }
    });
    const stop = () => {
        if(start) {
            start = null;
            setWidth(pane.offsetWidth, true);
        }
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
    grip.addEventListener("keydown", event => {
        const step = {ArrowLeft: -1, ArrowRight: 1}[event.key];
        if(step) {
            event.preventDefault();
            setWidth(pane.offsetWidth + step * (event.altKey ? 1 : 16), true);
        }
    });
    return grip;
}
