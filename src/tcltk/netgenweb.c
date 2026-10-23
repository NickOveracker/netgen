/*----------------------------------------------------------------------*/

/* netgenweb.c --							*/
/*									*/
/*	Entry points for the WebAssembly build of netgen (see build.sh	*/
/*	at the top of the repository).  WebAssembly can't load shared	*/
/*	objects, so tclnetgen is linked statically with Tcl and		*/
/*	registered as a static package; the startup script netgen.tcl	*/
/*	then loads it with "load {} Tclnetgen" in place of the shared	*/
/*	object.  The page calls:					*/
/*									*/
/*	  netgen_web_init(tcl_library, startup_script)			*/
/*	  netgen_web_eval(script)  -> the result string		*/
/*	  netgen_web_code()        -> TCL_OK, TCL_ERROR...		*/
/*									*/
/*	Output that netgen prints goes to Tcl's stdout and stderr	*/
/*	channels, which Emscripten passes to Module.print and		*/
/*	Module.printErr; both are flushed after every evaluation.	*/
/*----------------------------------------------------------------------*/
/* This file is part of the WebAssembly fork of netgen and, like	*/
/* netgen, is free software: you can redistribute it and/or modify it	*/
/* under the terms of the GNU General Public License as published by	*/
/* the Free Software Foundation, version 2 or (at your option) any	*/
/* later version.  It is distributed WITHOUT ANY WARRANTY; see the	*/
/* GNU General Public License in licenses/GPL-2.0.txt.			*/
/*----------------------------------------------------------------------*/

/*
 * Changes in the WebAssembly fork.
 * Added in the WebAssembly fork of netgen, https://github.com/NickOveracker/netgen
 * (branch wasm), on 2026-10-23.  Changes, with their dates:
 *   2026-10-23  Add a WebAssembly build of netgen, with Tcl
 * End of the changes notice.
 */

#include <stdio.h>
#include <tcl.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern int Tclnetgen_Init(Tcl_Interp *interp);

static Tcl_Interp *webInterp = NULL;
static int webCode = TCL_OK;

/*----------------------------------------------------------------------*/
/* A notifier for single-threaded WebAssembly.  Tcl 9 is always built	*/
/* with threads, and its Unix notifier starts a helper thread on the	*/
/* first Tcl_WaitForEvent(), even for TCL_DONT_WAIT polls such as	*/
/* netgen's check_interrupt(); without threads that fails and Tcl	*/
/* panics.  Nothing here could wake a notifier (no other threads, no	*/
/* file descriptors that become ready by themselves), so it only	*/
/* reports "nothing happened": at once when there is a timeout (timers	*/
/* check their own deadlines), and -1, "would wait forever", without	*/
/* one.  This follows the notifier in Magic's magic/magicWasm.c.	*/
/*----------------------------------------------------------------------*/

static int webNotifierData;

static void webSetTimer(const Tcl_Time *timePtr) { (void) timePtr; }

static int
webWaitForEvent(const Tcl_Time *timePtr)
{
    return (timePtr == NULL) ? -1 : 0;
}

static void
webCreateFileHandler(int fd, int mask, Tcl_FileProc *proc, void *clientData)
{
    (void) fd; (void) mask; (void) proc; (void) clientData;
}

static void webDeleteFileHandler(int fd) { (void) fd; }
static void *webInitNotifier(void) { return &webNotifierData; }
static void webFinalizeNotifier(void *clientData) { (void) clientData; }
static void webAlertNotifier(void *clientData) { (void) clientData; }
static void webServiceModeHook(int mode) { (void) mode; }

static const Tcl_NotifierProcs webNotifierProcs = {
    webSetTimer, webWaitForEvent, webCreateFileHandler,
    webDeleteFileHandler, webInitNotifier, webFinalizeNotifier,
    webAlertNotifier, webServiceModeHook
};

static void
webFlush(void)
{
    Tcl_Channel chan;

    if ((chan = Tcl_GetStdChannel(TCL_STDOUT)) != NULL)
	Tcl_Flush(chan);
    if ((chan = Tcl_GetStdChannel(TCL_STDERR)) != NULL)
	Tcl_Flush(chan);
    fflush(stdout);
    fflush(stderr);
}

/*----------------------------------------------------------------------*/
/* Create the interpreter, with Tcl's script library at "tcllib", and	*/
/* run netgen's startup script.  Returns TCL_OK (0) on success.		*/
/*----------------------------------------------------------------------*/

EMSCRIPTEN_KEEPALIVE int
netgen_web_init(const char *tcllib, const char *script)
{
    if (webInterp != NULL)
	return TCL_OK;

    Tcl_FindExecutable("netgen");
    Tcl_SetNotifier(&webNotifierProcs);	/* before the interpreter exists */
    webInterp = Tcl_CreateInterp();
    Tcl_SetVar(webInterp, "tcl_library", tcllib, TCL_GLOBAL_ONLY);
    Tcl_SetVar(webInterp, "argv", "", TCL_GLOBAL_ONLY);
    Tcl_SetVar(webInterp, "argc", "0", TCL_GLOBAL_ONLY);
    Tcl_SetVar(webInterp, "argv0", "netgen", TCL_GLOBAL_ONLY);
    Tcl_SetVar(webInterp, "tcl_interactive", "0", TCL_GLOBAL_ONLY);

    if (Tcl_Init(webInterp) != TCL_OK) {
	fprintf(stderr, "Tcl_Init: %s\n", Tcl_GetStringResult(webInterp));
	webFlush();
	return TCL_ERROR;
    }
    Tcl_StaticLibrary(NULL, "Tclnetgen", Tclnetgen_Init, NULL);

    /* Plain newlines on the console, as on Unix (Tcl would use CR-LF). */
    Tcl_Eval(webInterp, "fconfigure stdout -translation lf; "
		"fconfigure stderr -translation lf");

    webCode = Tcl_EvalFile(webInterp, script);
    if (webCode != TCL_OK)
	fprintf(stderr, "%s\n", Tcl_GetVar(webInterp, "errorInfo",
		TCL_GLOBAL_ONLY));
    webFlush();
    return webCode;
}

/*----------------------------------------------------------------------*/
/* Evaluate a script at the global level and return its result.  The	*/
/* string stays valid until the next call.				*/
/*----------------------------------------------------------------------*/

EMSCRIPTEN_KEEPALIVE const char *
netgen_web_eval(const char *script)
{
    if (webInterp == NULL) {
	webCode = TCL_ERROR;
	return "netgen is not started";
    }
    webCode = Tcl_EvalEx(webInterp, script, -1, TCL_EVAL_GLOBAL);
    webFlush();
    return Tcl_GetStringResult(webInterp);
}

EMSCRIPTEN_KEEPALIVE int
netgen_web_code(void)
{
    return webCode;
}
