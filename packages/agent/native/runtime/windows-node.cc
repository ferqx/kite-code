#include "library.h"

#ifdef _WIN32
#include <delayimp.h>

// Node-API comes from the current process image, including a renamed executable
// and a test runner that implements the same ABI. Do not search for node.exe.
static FARPROC WINAPI loadNode(unsigned int event, DelayLoadInfo* request) {
  if (event != dliNotePreLoadLibrary || _stricmp(request->szDll, "node.exe") != 0)
    return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = loadNode;
#endif
