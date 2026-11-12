#pragma once

#include <windows.h>
#include <shlobj.h>
#include <optional>
#include <string>

struct DesktopRegistration {
  std::wstring location;
  std::wstring prefix;
  std::wstring host;
  bool desktopShortcut = false;
};

std::wstring knownFolder(const KNOWNFOLDERID& folder);
std::wstring defaultDesktopLocation();
const wchar_t* integrationMutex();
std::wstring supportParent(const std::wstring& prefix);
bool isSupportHost(const std::wstring& path, const std::wstring& prefix);
bool isRootDesktopHost(const std::wstring& path, const std::wstring& prefix);
std::optional<DesktopRegistration> readDesktopRegistration();
std::wstring discoverDesktopLocation();
bool registerDesktop(const DesktopRegistration& desktop, const wchar_t* version);
bool applyDesktopShortcuts(const DesktopRegistration& desktop);
bool unregisterDesktop(const DesktopRegistration& desktop);
bool removeDesktopShortcuts(const DesktopRegistration& desktop);
