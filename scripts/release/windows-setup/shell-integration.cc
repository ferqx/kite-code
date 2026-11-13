#include "shell-integration.h"

#include <cwchar>
#include <iterator>
#include <memory>
#include <vector>

namespace {

#ifdef KITE_SETUP_FIXTURE
constexpr wchar_t registryPath[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KiteDesktopVerification";
constexpr wchar_t linkName[] = L"\\Kite Desktop Verification.lnk";
constexpr wchar_t displayName[] = L"Kite Desktop Verification";
constexpr wchar_t mutexName[] = L"Local\\KiteDesktopSetupVerification";
constexpr wchar_t directoryStem[] = L"KiteDesktopVerificationSupport-";
#else
constexpr wchar_t registryPath[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KiteDesktop";
constexpr wchar_t linkName[] = L"\\Kite Desktop.lnk";
constexpr wchar_t displayName[] = L"Kite Desktop";
constexpr wchar_t mutexName[] = L"Local\\KiteDesktopSetup";
constexpr wchar_t directoryStem[] = L"KiteDesktopSupport-";
#endif
constexpr wchar_t description[] = L"Kite 桌面版";
constexpr wchar_t bootstrapSuffix[] = L"\\bin\\kite-desktop.exe";
constexpr wchar_t hostSuffix[] = L"\\Kite Desktop.exe";

const auto release = [](auto* object) { object->Release(); };

struct RegistryKey {
  HKEY value = nullptr;
  ~RegistryKey() { if (value) RegCloseKey(value); }
};

bool equals(const std::wstring& left, const std::wstring& right) {
  return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool desktopResourcesPrefix(const std::wstring& prefix, const std::wstring& location) {
  return equals(prefix, location + L"\\resources\\app") ||
    equals(prefix, location + L"\\resources\\app-update");
}

std::wstring readString(HKEY key, const wchar_t* name) {
  std::vector<wchar_t> text(32768);
  DWORD bytes = static_cast<DWORD>(text.size() * sizeof(wchar_t));
  if (RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ | RRF_NOEXPAND, nullptr, text.data(), &bytes) != ERROR_SUCCESS)
    return L"";
  return text.data();
}

bool ordinaryFile(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
    !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

bool managed(const std::wstring& prefix) {
  return prefix.size() > 3 && prefix[1] == L':' && prefix[2] == L'\\' &&
    ordinaryFile(prefix + L"\\.kite-native-install.json") &&
    ordinaryFile(prefix + L"\\active") && ordinaryFile(prefix + bootstrapSuffix);
}

std::wstring prefixFromBootstrap(const std::wstring& path) {
  const size_t length = std::size(bootstrapSuffix) - 1;
  if (path.size() <= length + 3 || path[1] != L':' || path[2] != L'\\' ||
      _wcsicmp(path.c_str() + path.size() - length, bootstrapSuffix) != 0)
    return L"";
  return path.substr(0, path.size() - length);
}

bool supportHostInDirectory(const std::wstring& path, const std::wstring& parent) {
  if (path.empty() || parent.empty()) return false;
  const std::wstring base = parent + (parent.back() == L'\\' ? L"" : L"\\") + directoryStem;
  if (path.size() != base.size() + 38 + std::size(hostSuffix) - 1 ||
      _wcsnicmp(path.c_str(), base.c_str(), base.size()) != 0 ||
      _wcsicmp(path.c_str() + base.size() + 38, hostSuffix) != 0) return false;
  GUID id{};
  return SUCCEEDED(CLSIDFromString(path.substr(base.size(), 38).c_str(), &id));
}

struct Shortcut {
  std::wstring path;
  IShellLinkW* link = nullptr;
  IPersistFile* file = nullptr;
  bool present = false;
  std::wstring target;
  bool kiteDescription = false;

  explicit Shortcut(const KNOWNFOLDERID& folder) : path(knownFolder(folder) + linkName) {}
  ~Shortcut() {
    if (file) file->Release();
    if (link) link->Release();
  }
  bool open() {
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) ||
        FAILED(link->QueryInterface(IID_PPV_ARGS(&file)))) return false;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND;
    if ((attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
        FAILED(file->Load(path.c_str(), STGM_READ))) return false;
    present = true;
    std::vector<wchar_t> old(32768);
    wchar_t label[128]{};
    if (FAILED(link->GetPath(old.data(), static_cast<int>(old.size()), nullptr, SLGP_RAWPATH)) ||
        FAILED(link->GetDescription(label, 128))) return false;
    target = old.data();
    kiteDescription = wcscmp(label, description) == 0;
    return true;
  }
};

bool updateShortcut(const KNOWNFOLDERID& folder, const DesktopRegistration& desktop, bool enabled,
                    bool existingOnly = false) {
  Shortcut shortcut(folder);
  if (!shortcut.open()) return false;
  const auto supportDirectory = supportParent(shortcut.target);
  const bool own = shortcut.kiteDescription &&
    (equals(shortcut.target, desktop.host) || !prefixFromBootstrap(shortcut.target).empty() ||
      supportHostInDirectory(shortcut.target, supportParent(supportDirectory)));
  if (existingOnly && (!shortcut.present || !own)) return true;
  if (!enabled) return !shortcut.present || !own || DeleteFileW(shortcut.path.c_str());
  if (shortcut.present && !own) return false;
  return SUCCEEDED(shortcut.link->SetPath(desktop.host.c_str())) &&
    SUCCEEDED(shortcut.link->SetDescription(description)) &&
    SUCCEEDED(shortcut.link->SetArguments(L"")) &&
    SUCCEEDED(shortcut.link->SetWorkingDirectory(desktop.prefix.c_str())) &&
    SUCCEEDED(shortcut.file->Save(shortcut.path.c_str(), TRUE));
}

bool removeShortcut(const KNOWNFOLDERID& folder, const DesktopRegistration& desktop) {
  Shortcut shortcut(folder);
  if (!shortcut.open()) return false;
  if (!shortcut.present || !shortcut.kiteDescription) return true;
  const bool own = equals(shortcut.target, desktop.host) ||
    equals(shortcut.target, desktop.prefix + bootstrapSuffix);
  return !own || DeleteFileW(shortcut.path.c_str());
}

bool setString(HKEY key, const wchar_t* name, const std::wstring& value) {
  return RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
    static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}

bool setFlag(HKEY key, const wchar_t* name, DWORD value) {
  return RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value),
    sizeof(value)) == ERROR_SUCCESS;
}

} // namespace

std::wstring knownFolder(const KNOWNFOLDERID& folder) {
  wchar_t* raw = nullptr;
  if (FAILED(SHGetKnownFolderPath(folder, 0, nullptr, &raw)))
    throw std::wstring(L"无法定位当前用户的 Windows 文件夹。");
  const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> path(raw, CoTaskMemFree);
  std::wstring result(path.get());
  while (result.size() > 3 && result.back() == L'\\') result.pop_back();
  return result;
}

const wchar_t* integrationMutex() { return mutexName; }

std::wstring defaultDesktopLocation() {
#ifdef KITE_SETUP_FIXTURE
  return knownFolder(FOLDERID_LocalAppData) + L"\\KiteDesktopVerification";
#else
  return knownFolder(FOLDERID_LocalAppData) + L"\\KiteDesktop";
#endif
}

std::wstring supportParent(const std::wstring& prefix) {
  if (prefix.size() <= 3 || prefix[1] != L':' || prefix[2] != L'\\') return L"";
  const size_t separator = prefix.find_last_of(L'\\');
  return prefix.substr(0, separator == 2 ? 3 : separator);
}

bool isSupportHost(const std::wstring& path, const std::wstring& prefix) {
  return isRootDesktopHost(path, prefix) || supportHostInDirectory(path, supportParent(prefix));
}

bool isRootDesktopHost(const std::wstring& path, const std::wstring& prefix) {
  const auto location = supportParent(supportParent(prefix));
  return !location.empty() && desktopResourcesPrefix(prefix, location) &&
    equals(path, location + hostSuffix);
}

std::optional<DesktopRegistration> readDesktopRegistration() {
  RegistryKey key;
  const LSTATUS opened = RegOpenKeyExW(HKEY_CURRENT_USER, registryPath, 0, KEY_QUERY_VALUE, &key.value);
  if (opened == ERROR_FILE_NOT_FOUND) return std::nullopt;
  if (opened != ERROR_SUCCESS) throw std::wstring(L"无法读取 Kite 的 Windows 安装记录。");
  const auto host = readString(key.value, L"KiteHost");
  const auto location = readString(key.value, L"InstallLocation");
  const auto prefix = readString(key.value, L"KiteManagedPrefix");
  if (!isSupportHost(host, prefix) || location.empty() ||
      !(equals(prefix, location) || equals(prefix, location + L"\\client") ||
        desktopResourcesPrefix(prefix, location))) return std::nullopt;
  DWORD desktop = 0, bytes = sizeof(desktop);
  RegGetValueW(key.value, nullptr, L"KiteDesktopShortcut", RRF_RT_REG_DWORD, nullptr, &desktop, &bytes);
  return DesktopRegistration{location, prefix, host, desktop != 0};
}

std::wstring discoverDesktopLocation() {
  const auto registered = readDesktopRegistration();
  if (registered && (managed(registered->prefix) ||
      managed(registered->location + L"\\resources\\app") ||
      managed(registered->location + L"\\resources\\app-update"))) return registered->location;
  Shortcut menu(FOLDERID_Programs);
  if (menu.open() && menu.present && menu.kiteDescription) {
    const auto prefix = prefixFromBootstrap(menu.target);
    if (managed(prefix)) {
      const auto separator = prefix.find_last_of(L'\\');
      if (separator > 2 && _wcsicmp(prefix.c_str() + separator + 1, L"client") == 0)
        return prefix.substr(0, separator);
      return prefix;
    }
    const auto location = supportParent(menu.target);
    if (equals(menu.target, location + hostSuffix) &&
        (managed(location + L"\\resources\\app") || managed(location + L"\\resources\\app-update")))
      return location;
  }
  const auto fallback = defaultDesktopLocation();
  if (managed(fallback) || managed(fallback + L"\\client") ||
      managed(fallback + L"\\resources\\app") || managed(fallback + L"\\resources\\app-update"))
    return fallback;
  return L"";
}

bool registerDesktop(const DesktopRegistration& desktop, const wchar_t* version) {
  if (!isSupportHost(desktop.host, desktop.prefix) || !ordinaryFile(desktop.host) || !managed(desktop.prefix)) return false;
  RegistryKey key;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, registryPath, 0, nullptr, REG_OPTION_NON_VOLATILE,
      KEY_SET_VALUE, nullptr, &key.value, nullptr) != ERROR_SUCCESS) return false;
  const auto command = L"\"" + desktop.host + L"\" --uninstall";
  return setString(key.value, L"KiteHost", desktop.host) &&
    setString(key.value, L"KiteManagedPrefix", desktop.prefix) &&
    setString(key.value, L"InstallLocation", desktop.location) &&
    setString(key.value, L"DisplayVersion", version) &&
    setString(key.value, L"Publisher", L"Kite") &&
    setString(key.value, L"DisplayIcon", L"\"" + desktop.host + L"\",0") &&
    setString(key.value, L"UninstallString", command) &&
    setString(key.value, L"QuietUninstallString", command + L" --quiet") &&
    setFlag(key.value, L"NoModify", 1) && setFlag(key.value, L"NoRepair", 1) &&
    setFlag(key.value, L"KiteDesktopShortcut", desktop.desktopShortcut ? 1 : 0) &&
    setString(key.value, L"DisplayName", displayName);
}

bool applyDesktopShortcuts(const DesktopRegistration& desktop, bool upgrade) {
  const bool menu = updateShortcut(FOLDERID_Programs, desktop, true);
  const bool icon = updateShortcut(FOLDERID_Desktop, desktop, upgrade || desktop.desktopShortcut, upgrade);
  return menu && icon;
}

bool unregisterDesktop(const DesktopRegistration& desktop) {
  const auto current = readDesktopRegistration();
  return current && equals(current->host, desktop.host) && equals(current->prefix, desktop.prefix) &&
    RegDeleteKeyW(HKEY_CURRENT_USER, registryPath) == ERROR_SUCCESS;
}

bool removeDesktopShortcuts(const DesktopRegistration& desktop) {
  const bool menu = removeShortcut(FOLDERID_Programs, desktop);
  const bool icon = removeShortcut(FOLDERID_Desktop, desktop);
  return menu && icon;
}
