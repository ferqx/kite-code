#pragma once

#include <string>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <filesystem>
#else
#include <dlfcn.h>
#endif

namespace kite {
#ifdef _WIN32
using LibraryHandle = HMODULE;
inline LibraryHandle openSqliteLibrary(const std::string& path) {
  const auto wide = std::filesystem::u8path(path).native();
  return LoadLibraryExW(wide.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
}
inline void* librarySymbol(LibraryHandle handle, const char* name) {
  return reinterpret_cast<void*>(GetProcAddress(handle, name));
}
inline bool closeLibrary(LibraryHandle handle) { return FreeLibrary(handle) != FALSE; }
#else
using LibraryHandle = void*;
inline LibraryHandle openSqliteLibrary(const std::string& path) {
  constexpr int flags = RTLD_NOW | RTLD_LOCAL
#ifdef __APPLE__
      | RTLD_FIRST
#endif
      ;
  return dlopen(path.c_str(), flags);
}
inline void* librarySymbol(LibraryHandle handle, const char* name) { return dlsym(handle, name); }
inline bool closeLibrary(LibraryHandle handle) { return dlclose(handle) == 0; }
#endif
}
