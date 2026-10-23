# Licences of what netgen.wasm contains

`netgen.js` and `netgen.wasm` are built from:

- **netgen** (the sources in `src/`): the GNU General Public License, in `Copying` at the top of the repository.
- **Tcl 9.0.4**, linked in statically, with its script library embedded: the licence in `tcl-license.terms`, copied
  verbatim from the release that was built, as that licence asks.
- **The Emscripten runtime** (the JavaScript loader and the C library compiled in): the MIT licence and the
  University of Illinois/NCSA licence in `emscripten-LICENSE`, from the Emscripten release that was used.
