# netgen for WebAssembly

netgen, the netlist comparison (LVS) tool from Open Circuit Design, compiled to WebAssembly with
[Emscripten](https://emscripten.org) together with Tcl, and a web app around it. netgen's LVS (the `lvs` command and the
process kits' setup files) is written in Tcl, so the module carries a Tcl 9 interpreter; it runs in a plain Web Worker
and needs no special server headers.

The app is what this folder holds. netgen's own source, with its original README and native build, is in `src/`.

## Building

```sh
source /path/to/emsdk/emsdk_env.sh
./build.sh                  # OPT="-O1 -g" OUT_DIR=/tmp/x ./build.sh for a debugging build elsewhere
python3 -m http.server      # from the repository root; then open /
```

`build.sh` clones and builds Tcl (release `core-9-0-4`, or `$TCL_REF`) as a static WebAssembly library in `build-web/`
the first time, compiles netgen's sources in `src/` against it, and links `netgen.js` (a module factory named
`createNetgen`) and `netgen.wasm`, about 2.3 MB, next to the app, where they are committed so that the app works on
GitHub Pages. Tcl's script library and netgen's startup script are embedded in the module. Browsers don't start
workers from `file://` pages, so serve the folder over HTTP.

## The web app

| File | Role |
| --- | --- |
| `index.html`, `app.js` | The page: console, Project / Examples / Windows / About menus, the Compare, Result and Files windows, projects, help. |
| `worker.js`, `session.js` | netgen in a Web Worker, one command at a time. **Stop** ends a command that runs too long: netgen starts again and replays the commands before it. |
| `menu.js`, `dialog.js`, `floating-window.js`, `archive.js`, `storage.js` | Menus, dialogs, windows, .zip/.tar.gz, project storage (shared with the Magic and IRSIM web apps). |
| `setups/scmos.tcl` | A built-in setup for Magic's scmos technology. |
| `examples/` | Netlists extracted by Magic from layouts exported by the Stixu stick-diagram editor (https://stixu.io), with schematics and a deliberately miswired copy. |
| `licenses/` | The licences of Tcl and the Emscripten runtime, which the module contains. |

* **Compare.** Choose the two netlists (usually a layout's extracted netlist and a schematic), the cell in each, and a
  setup file, then Run LVS. This runs `lvs {file cell} {file cell} setup comp.out -json` after `reinitialize`, so
  edited files are read again.
* **Result.** The verdict from netgen's report, and from its JSON output, per compared cell: devices by class and nets,
  the nets and devices that differ side by side, property (size) differences, and pins; then the full report.
* **Console.** Any netgen or Tcl command. `quit` and `exit` are the page's: they would end netgen.
* **Projects.** Open netlists and setup files, a folder, or one .zip/.tar/.tar.gz (or drop them on the page). Projects
  can be kept in a folder on disk (Chromium browsers) or in the browser's storage; reports netgen writes and edits in
  the Files window go there.

## Using the module directly

```js
const netgen = await createNetgen({print, printErr, stdin: () => null});
netgen.ccall("netgen_web_init", "number", ["string", "string"], ["/tcl/library", "/netgen/tcl/netgen.tcl"]);
netgen.FS.mkdir("/work"); netgen.FS.chdir("/work");
netgen.FS.writeFile("layout.spice", layoutText);
netgen.FS.writeFile("schematic.spice", schematicText);
netgen.ccall("netgen_web_eval", "string", ["string"],
    ["lvs {layout.spice top} {schematic.spice top} nosetup comp.out -json"]);
netgen.ccall("netgen_web_code", "number", [], []);     // 0 (TCL_OK) if the command succeeded
JSON.parse(new TextDecoder().decode(netgen.FS.readFile("comp.json")));
```

## Source changes

The build needs two additions, both in the web build only: `src/tcltk/netgenweb.c`, which creates the interpreter,
registers tclnetgen as a static package (the startup script loads it with `load {} Tclnetgen` in place of the shared
object) and evaluates commands; and a single-threaded Tcl notifier in the same file, after the one in Magic's
`magic/magicWasm.c`, since Tcl 9 otherwise starts a notifier thread on its first event-loop poll. netgen is compiled
with `-std=gnu17`, because it declares many functions without prototypes, which C23 rejects.

Running every netgen command in WebAssembly, and comparing with a native build, turned up bugs that affect native
netgen too; each is a separate commit on this branch:

* `timing.c`, `xilinx.c`: the address of a `long` was passed to `time()` and `ctime()`. Where `time_t` is 64 bits and
  `long` 32, as in WebAssembly, `time()` wrote past the variable.
* `objlist.c`: `FreeObject()` freed a port's number as if it were a class name, so deleting a cell with ports (a library
  redefining a cell, as `readlib actel` then `readlib xilinx` do) crashed.
* `actellib.c`, `xillib.c`: `readlib` before any netlist had been read looked up its cells through a null match function.
* `netfile.c`: `writenet netgen` closed descriptor 0 instead of the file it had opened; Tcl then aborted ("duplicate
  channel names") at the next file it opened, for example the JSON output of `lvs`.
* `ext.c`: a .sim or .ext file read after a SPICE file switched to case-sensitive matching under the cells already read,
  so `lvs {layout.spice cell} layout.sim` failed with "No such cell or bad file number!". It now keeps the earlier choice
  with a warning, as the Verilog reader does.
* `query.c`: at the end of input, `protochip` printed its menu and read again forever.

## Checks

* Thirteen comparisons (Magic-extracted SPICE and .sim netlists, Stixu's own IRSIM exports, two sizings of the same
  circuits, a miswired copy, and a 338-transistor multiplier, in both reading orders) give the same reports and JSON as
  native netgen 1.5.325 built from the same sources, byte for byte except where netgen lists entries in hash order (its
  hash functions use `unsigned long`, which is 32 bits in WebAssembly) or sorts equal entries differently.
* Every command in netgen's command tables ran in a debugging build, with typical arguments, without a trap; the
  bugs above were found that way.
* The app was tested in headless Chromium and Firefox: every example, the Compare window, editing a netlist and
  running again, the console, Stop, and browser storage across a reload.
