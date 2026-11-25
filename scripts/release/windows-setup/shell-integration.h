#pragma once

#include <windows.h>
#include <shlobj.h>
#include <optional>
#include <string>

#ifdef KITE_SETUP_FIXTURE
inline constexpr wchar_t desktopFolderName[] = L"KiteVerification";
#else
inline constexpr wchar_t desktopFolderName[] = L"Kite";
#endif
inline constexpr wchar_t desktopExecutableName[] = L"Kite.exe";

struct DesktopRegistration {
  std::wstring location;
  std::wstring prefix;
  std::wstring host;
  bool desktopShortcut = false;
};

std::wstring knownFolder(const KNOWNFOLDERID& folder, DWORD flags = 0);
std::wstring defaultDesktopLocation();
std::wstring desktopHostPath(const std::wstring& location);
const wchar_t* integrationMutex();
std::wstring supportParent(const std::wstring& prefix);
bool isSupportHost(const std::wstring& path, const std::wstring& prefix);
bool isRootDesktopHost(const std::wstring& path, const std::wstring& prefix);
std::optional<DesktopRegistration> readDesktopRegistration();
std::wstring discoverDesktopLocation();
bool registerDesktop(const DesktopRegistration& desktop, const wchar_t* version);
bool applyDesktopShortcuts(const DesktopRegistration& desktop, bool upgrade);
bool unregisterDesktop(const DesktopRegistration& desktop);
bool removeDesktopShortcuts(const DesktopRegistration& desktop);
