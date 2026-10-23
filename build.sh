#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Build netgen to WebAssembly, with Tcl, for the web app in this folder.
#
# netgen's LVS (the "lvs" command and the setup files of PDKs) is Tcl, so
# the module contains a Tcl interpreter: Tcl is built as a static WebAssembly
# library, netgen's sources in src/ are compiled against it, and tclnetgen is
# registered as a static package (src/tcltk/netgenweb.c).  Tcl's script
# library and netgen's startup script are embedded in the module's file
# system.
#
# Needs the Emscripten SDK on the PATH (source emsdk_env.sh), git, and a host
# C compiler (Tcl's build runs a helper program natively).  Writes netgen.js
# and netgen.wasm next to the app; they are committed, so that the app works
# when the branch is served as a static site (GitHub Pages).
#
# Environment: TCL_REF (default core-9-0-4) is the Tcl release to build;
# BUILD_DIR (default build-web) holds Tcl's source and build; OPT (default
# -O2) is the optimisation, for example "-O1 -g" for a debugging build with
# names in stack traces; OUT_DIR (default this folder) receives the module.
set -e
cd "$(dirname "$0")"
TOP=$(pwd)
TCL_REF=${TCL_REF:-core-9-0-4}
BUILD_DIR=${BUILD_DIR:-$TOP/build-web}
OPT=${OPT:--O2}
OUT_DIR=${OUT_DIR:-$TOP}
TCL_SRC=$BUILD_DIR/tcl
TCL_OUT=$BUILD_DIR/tcl-wasm
mkdir -p "$BUILD_DIR"

command -v emcc >/dev/null || { echo "emcc not found (source emsdk_env.sh)" >&2; exit 1; }

# --- Tcl, once ---------------------------------------------------------------
# The configure settings follow Magic's toolchains/emscripten/build-tcl-wasm.sh:
# static, no dynamic loading, and the select() notifier (Emscripten has an
# epoll header, but epoll doesn't work in WebAssembly).
if [ ! -f "$TCL_OUT/install/lib/tclConfig.sh" ]; then
  if [ ! -d "$TCL_SRC" ]; then
    git -c core.autocrlf=false clone --depth 1 --branch "$TCL_REF" https://github.com/tcltk/tcl.git "$TCL_SRC"
  fi
  mkdir -p "$TCL_OUT"
  (
    cd "$TCL_OUT"
    CFLAGS="-O2 -sUSE_ZLIB=1" ac_cv_header_sys_epoll_h=no ac_cv_func_epoll_create=no ac_cv_func_epoll_create1=no \
      emconfigure "$TCL_SRC/unix/configure" --disable-shared --disable-load --enable-symbols=no \
        --host=wasm32-unknown-emscripten --prefix="$TCL_OUT/install"
    TCL_LIB_FILE=$(. ./tclConfig.sh && echo "$TCL_LIB_FILE")
    emmake make -j"$(nproc 2>/dev/null || echo 2)" HOST_CC=gcc HOST_AR=ar HOST_RANLIB=ranlib HOST_EXEEXT= \
      HOST_OBJEXT=hostobj "$TCL_LIB_FILE"
    emmake make HOST_CC=gcc HOST_AR=ar HOST_RANLIB=ranlib HOST_EXEEXT= HOST_OBJEXT=hostobj \
      install-headers install-libraries
    mkdir -p install/lib
    cp -f "$TCL_LIB_FILE" tclConfig.sh install/lib/
  )
fi
TCL_VERSION=$(. "$TCL_OUT/install/lib/tclConfig.sh" && echo "$TCL_VERSION")
TCL_LIB=$TCL_OUT/install/lib/libtcl$TCL_VERSION.a

# --- The files the module carries ---------------------------------------------
# Tcl's script library without the encodings (UTF-8 and Latin-1 are built in)
# and the packages netgen doesn't use, and netgen's startup script with its
# "load" of the shared object replaced by the static package.
FS=$BUILD_DIR/fs
rm -rf "$FS"
mkdir -p "$FS/tcl/library" "$FS/netgen/tcl"
cp "$TCL_OUT/install/lib/tcl$TCL_VERSION"/*.tcl "$TCL_OUT/install/lib/tcl$TCL_VERSION/tclIndex" "$FS/tcl/library/"
cp -r "$TCL_OUT/install/lib/tcl$TCL_VERSION/opt0.4" "$FS/tcl/library/"
# The copy is a modified file, so it says so (GPL, paragraph 2a).
sed -e 's%^load TCL_DIR/tclnetgenSHDLIB_EXT$%load {} Tclnetgen%' \
    -e 's%TCL_DIR%/netgen/tcl%g' -e 's%SHDLIB_EXT%%g' \
    -e '1i\
# Modified for the WebAssembly fork of netgen (https://github.com/NickOveracker/netgen,\
# branch wasm) by its build.sh, which writes this copy of src/tcltk/netgen.tcl.in.\
# Changes, with their dates:\
#   2026-10-23  The "load" of the shared object tclnetgen.so is "load {} Tclnetgen",\
#               netgen being linked into the WebAssembly module as a static package.\
' src/tcltk/netgen.tcl.in > "$FS/netgen/tcl/netgen.tcl"
grep -q '^load {} Tclnetgen$' "$FS/netgen/tcl/netgen.tcl" || { echo "netgen.tcl: load line not replaced" >&2; exit 1; }

# --- netgen --------------------------------------------------------------------
# The definitions are those netgen's configure writes for a Tcl build, with
# WebAssembly's 32-bit sizes and without Tcl stubs (Tcl is linked in).
# -std=gnu17: netgen declares many functions without prototypes, which C23
# no longer allows.
REVISION=$(sed -e 's/^[0-9]*\.[0-9]*\.//' src/VERSION)
VERSION=$(sed -e 's/^\([0-9]*\.[0-9]*\)\..*/\1/' src/VERSION)
Q='\"'
DEFS="-DCAD_DIR=$Q/netgen$Q -DTCL_DIR=$Q/netgen/tcl$Q -DNETGEN_VERSION=$Q$VERSION$Q -DNETGEN_REVISION=$Q$REVISION$Q
 -DNETGEN_DATE=$Q$(date -u '+%Y-%m-%d')$Q -DSTDC_HEADERS=1 -DHAVE_SYS_TYPES_H=1 -DHAVE_SYS_STAT_H=1 -DHAVE_STDLIB_H=1
 -DHAVE_STRING_H=1 -DHAVE_MEMORY_H=1 -DHAVE_STRINGS_H=1 -DHAVE_INTTYPES_H=1 -DHAVE_STDINT_H=1 -DHAVE_UNISTD_H=1
 -DSIZEOF_VOID_P=4 -DSIZEOF_UNSIGNED_INT=4 -DSIZEOF_UNSIGNED_LONG=4 -DSIZEOF_UNSIGNED_LONG_LONG=8 -DHAVE_SETENV=1
 -DHAVE_PUTENV=1 -DHAVE_DIRENT_H=1 -DHAVE_LIMITS_H=1 -DHAVE_VA_COPY=1 -DHAVE___VA_COPY=1 -DDBUG_OFF=1 -DTCL_NETGEN=1
 -Dlinux=1 -DSYSV=1 -DISC=1 -DSHDLIB_EXT=$Q$Q -DNDEBUG"
BASE="actel.c ccode.c greedy.c ntk.c print.c actellib.c embed.c hash.c netfile.c objlist.c query.c anneal.c ext.c
 netcmp.c netgen.c pdutils.c random.c timing.c bottomup.c flatten.c place.c spice.c verilog.c wombat.c xilinx.c xillib.c"
SRCS="$(for f in $BASE; do printf 'src/base/%s ' "$f"; done) src/tcltk/tclnetgen.c src/tcltk/netgenweb.c"

eval emcc -std=gnu17 $OPT -w $DEFS -Isrc/base -I"$TCL_OUT/install/include" $SRCS "$TCL_LIB" -o "$OUT_DIR/netgen.js" \
  -sUSE_ZLIB=1 -sMODULARIZE=1 -sEXPORT_NAME=createNetgen -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4MB -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap \
  -sEXPORTED_FUNCTIONS=_netgen_web_init,_netgen_web_eval,_netgen_web_code \
  --embed-file "$FS/tcl@/tcl" --embed-file "$FS/netgen@/netgen"
ls -la "$OUT_DIR/netgen.js" "$OUT_DIR/netgen.wasm"
