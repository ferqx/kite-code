#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define NAPI_VERSION 8
#define NAPI_EXTERN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include "node_api.h"
#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

// All signatures and registration types come from the pinned official Node-API headers.
#define API_LIST(X) X(napi_get_cb_info) X(napi_get_value_string_utf16) X(napi_create_object) X(napi_create_function) X(napi_set_named_property) X(napi_wrap) X(napi_unwrap) X(napi_get_undefined) X(napi_throw_error)
#define DECLARE(name) static decltype(&name) p_##name;
API_LIST(DECLARE)
static void need(bool ok) { if (!ok) throw std::runtime_error("windows_access_denied"); }
static void check(napi_status status) { need(status == napi_ok); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); value = other.value; other.value = INVALID_HANDLE_VALUE; } return *this; }
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  void close() { if (value != INVALID_HANDLE_VALUE) { need(CloseHandle(value)); value = INVALID_HANDLE_VALUE; } }
};
struct Local {
  void* value = nullptr;
  Local() = default;
  Local(const Local&) = delete;
  Local(Local&& other) noexcept : value(other.value) { other.value = nullptr; }
  ~Local() { if (value) LocalFree(value); }
};
static std::wstring parent(const std::wstring& path) {
  if (path.size() == 3 && path[1] == L':' && path[2] == L'\\') return path;
  const auto at = path.find_last_of(L'\\');
  need(at != std::wstring::npos);
  return at == 2 ? path.substr(0, 3) : path.substr(0, at);
}
static std::wstring canonical(const std::wstring& path) {
  // Fixed local drive backend; no UNC/device namespace or relative/ambiguous suffix.
  need(path.size() >= 3 && path.size() <= 32760 && path[1] == L':' && path[2] == L'\\');
  need(path.find(L'\0') == std::wstring::npos && path.find(L'/') == std::wstring::npos);
  wchar_t result[32768];
  DWORD size = GetFullPathNameW(path.c_str(), 32768, result, nullptr);
  need(size && size < 32768);
  std::wstring fixed(result, size);
  need(fixed == path && (fixed.size() == 3 || fixed.back() != L'\\'));
  for (size_t start = 3; start < fixed.size();) {
    const auto end = fixed.find(L'\\', start);
    const auto part = fixed.substr(start, end == std::wstring::npos ? end : end - start);
    need(!part.empty() && part.back() != L'.' && part.back() != L' ' && part.find(L':') == std::wstring::npos);
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return fixed;
}
static Handle openDirectory(const std::wstring& path) {
  auto h = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  need(h != INVALID_HANDLE_VALUE);
  return Handle(h);
}
static void canonicalHandle(HANDLE handle, const std::wstring& path) {
  wchar_t result[32768];
  DWORD bytes = GetFinalPathNameByHandleW(handle, result, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  need(bytes && bytes < 32768);
  std::wstring actual(result, bytes);
  need(actual.rfind(L"\\\\?\\", 0) == 0);
  need(actual.substr(4) == path);
}
static BY_HANDLE_FILE_INFORMATION info(HANDLE h, bool directory) {
  BY_HANDLE_FILE_INFORMATION value{};
  need(GetFileInformationByHandle(h, &value));
  need(!(value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  need(!!(value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory);
  if (!directory) need(value.nNumberOfLinks == 1);
  return value;
}
static bool same(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}
struct Policy {
  std::vector<unsigned char> user;
  PSID sid = nullptr;
  std::wstring text;
  Policy() {
    HANDLE raw;
    need(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw));
    Handle token(raw);
    DWORD bytes = 0;
    GetTokenInformation(raw, TokenUser, nullptr, 0, &bytes);
    need(bytes && bytes <= 65536);
    user.resize(bytes);
    need(GetTokenInformation(raw, TokenUser, user.data(), bytes, &bytes));
    sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    need(IsValidSid(sid));
    Local converted;
    need(ConvertSidToStringSidW(sid, reinterpret_cast<LPWSTR*>(&converted.value)));
    text = static_cast<wchar_t*>(converted.value);
  }
  void acl(HANDLE h, bool directory, bool privateObject) const {
    PSID owner = nullptr;
    PACL dacl = nullptr;
    Local descriptor;
    need(GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &dacl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
    need(owner && dacl && EqualSid(owner, sid));
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision;
    need(GetSecurityDescriptorControl(descriptor.value, &control, &revision));
    need(control & SE_DACL_PRESENT);
    if (privateObject) {
      need(!directory || (control & SE_DACL_PROTECTED));
      need(dacl->AceCount == 1);
    }
    need(dacl->AceCount <= 4096);
    for (DWORD i = 0; i < dacl->AceCount; ++i) {
      void* raw;
      need(GetAce(dacl, i, &raw));
      const auto header = static_cast<ACE_HEADER*>(raw);
      const auto offset = static_cast<unsigned char*>(raw) - reinterpret_cast<unsigned char*>(dacl);
      need(offset >= sizeof(ACL) && offset + header->AceSize <= dacl->AclSize && header->AceSize >= sizeof(ACCESS_ALLOWED_ACE));
      need((header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) && !(header->AceFlags & ~0x1f));
      const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      PSID principal = const_cast<DWORD*>(&ace->SidStart);
      need(IsValidSid(principal) && GetLengthSid(principal) <= header->AceSize - 8);
      if (privateObject) {
        need(header->AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(principal, sid) && ace->Mask == FILE_ALL_ACCESS);
        need(!(header->AceFlags & ~0x13) && (!directory || (header->AceFlags & 3) == 3));
      } else if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const bool privileged = EqualSid(principal, sid) || IsWellKnownSid(principal, WinLocalSystemSid) || IsWellKnownSid(principal, WinBuiltinAdministratorsSid);
        need(privileged || !(ace->Mask & ~0xa01200a9u));
      }
    }
  }
  Local descriptor(bool directory) const {
    Local sd;
    const auto sddl = L"O:" + text + L"D:P(A;" + (directory ? std::wstring(L"OICI") : std::wstring()) + L";FA;;;" + text + L")";
    need(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value), nullptr));
    return sd;
  }
};
struct Entry {
  std::wstring path;
  Handle handle;
  BY_HANDLE_FILE_INFORMATION identity;
  bool privateObject;
  bool checkAcl;
};
struct Lease {
  Policy policy;
  std::vector<Entry> entries;
  Handle lock;
  OVERLAPPED region{};
  std::wstring lockPath;
  BY_HANDLE_FILE_INFORMATION lockIdentity{};
  std::wstring profilePath;
  Handle uiDatabase;
  BY_HANDLE_FILE_INFORMATION uiIdentity{};
  bool uiPreparationStarted = false;
  bool uiPrepared = false;
  bool acquired = false;
  bool closed = false;
  ~Lease() { if (acquired && lock.value != INVALID_HANDLE_VALUE) UnlockFileEx(lock.value, 0, 1, 0, &region); }
  void pin(const std::wstring& path, bool privateObject, bool checkAcl) {
    auto held = openDirectory(path);
    canonicalHandle(held.value, path);
    const auto identity = info(held.value, true);
    if (checkAcl) policy.acl(held.value, true, privateObject);
    entries.push_back({path, std::move(held), identity, privateObject, checkAcl});
  }
  void ancestors(const std::wstring& root, bool candidate) {
    auto path = root;
    for (size_t depth = 0;; ++depth) {
      need(depth < 256);
      pin(path, false, candidate && depth < 2);
      const auto next = parent(path);
      if (next == path) break;
      path = next;
    }
  }
  void privateDirectory(const std::wstring& path) {
    DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      need(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND);
      if (GetFileAttributesW(parent(path).c_str()) == INVALID_FILE_ATTRIBUTES) privateDirectory(parent(path));
      auto sd = policy.descriptor(true);
      SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), sd.value, FALSE};
      need(CreateDirectoryW(path.c_str(), &security) || GetLastError() == ERROR_ALREADY_EXISTS);
    }
    auto h = openDirectory(path);
    info(h.value, true);
    policy.acl(h.value, true, true);
  }
  Handle privateFile(const std::wstring& path, bool create) {
    auto sd = policy.descriptor(false);
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), sd.value, FALSE};
    HANDLE raw = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, create ? &security : nullptr,
      create ? CREATE_NEW : OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (raw == INVALID_HANDLE_VALUE && create && (GetLastError() == ERROR_FILE_EXISTS || GetLastError() == ERROR_ALREADY_EXISTS))
      raw = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    need(raw != INVALID_HANDLE_VALUE);
    Handle h(raw);
    info(h.value, false);
    policy.acl(h.value, false, true);
    return h;
  }
  void acquire(const std::wstring& path) {
    lockPath = path;
    lock = privateFile(path, true);
    lockIdentity = info(lock.value, false);
    if (!LockFileEx(lock.value, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &region)) {
      if (GetLastError() == ERROR_LOCK_VIOLATION) throw std::runtime_error("owner_busy");
      need(false);
    }
    acquired = true;
    verify();
  }
  void verify() {
    need(!closed && acquired && lock.value != INVALID_HANDLE_VALUE);
    for (auto& entry : entries) {
      need(entry.handle.value != INVALID_HANDLE_VALUE && same(info(entry.handle.value, true), entry.identity));
      auto fresh = openDirectory(entry.path);
      canonicalHandle(fresh.value, entry.path);
      need(same(info(fresh.value, true), entry.identity));
      if (entry.checkAcl) { policy.acl(entry.handle.value, true, entry.privateObject); policy.acl(fresh.value, true, entry.privateObject); }
    }
    auto fresh = privateFile(lockPath, false);
    need(same(info(lock.value, false), lockIdentity) && same(info(fresh.value, false), lockIdentity));
    if (!profilePath.empty()) {
      const auto journal = parent(lockPath) + L"\\restore-journal.json";
      if (GetFileAttributesW(journal.c_str()) != INVALID_FILE_ATTRIBUTES) throw std::runtime_error("restore_reconciliation_required");
      need(GetLastError() == ERROR_FILE_NOT_FOUND);
      const auto attributes = GetFileAttributesW(profilePath.c_str());
      if (attributes != INVALID_FILE_ATTRIBUTES) { auto profile = openDirectory(profilePath); info(profile.value, true); }
      else need(GetLastError() == ERROR_FILE_NOT_FOUND);
    }
  }
  void release() {
    if (closed) return;
    bool failure = false;
    if (lock.value != INVALID_HANDLE_VALUE) {
      if (acquired && !UnlockFileEx(lock.value, 0, 1, 0, &region)) failure = true;
      if (CloseHandle(lock.value)) { lock.value = INVALID_HANDLE_VALUE; acquired = false; }
      else failure = true;
    }
    if (lock.value == INVALID_HANDLE_VALUE) {
      try { uiDatabase.close(); } catch (...) { failure = true; }
      if (uiDatabase.value == INVALID_HANDLE_VALUE) {
        for (auto it = entries.rbegin(); it != entries.rend(); ++it) {
          try { it->handle.close(); } catch (...) { failure = true; }
        }
      }
    }
    closed = lock.value == INVALID_HANDLE_VALUE && uiDatabase.value == INVALID_HANDLE_VALUE && std::all_of(entries.begin(), entries.end(), [](const Entry& entry) { return entry.handle.value == INVALID_HANDLE_VALUE; });
    need(!failure && closed);
  }
  void preparePrivateUi() {
    verify(); need(!profilePath.empty() && !uiPreparationStarted);
    uiPreparationStarted = true;
    pin(profilePath, true, true);
    const auto directory = profilePath + L"\\desktop-private";
    privateDirectory(directory);
    pin(directory, true, true);
    const auto path = directory + L"\\data.sqlite";
    uiDatabase = privateFile(path, true);
    canonicalHandle(uiDatabase.value, path);
    uiIdentity = info(uiDatabase.value, false);
    uiPrepared = true;
    verifyPrivateUi();
  }
  void verifyPrivateUi() {
    verify(); need(!profilePath.empty() && uiPrepared && uiDatabase.value != INVALID_HANDLE_VALUE);
    const auto directory = profilePath + L"\\desktop-private";
    need(same(info(uiDatabase.value, false), uiIdentity));
    policy.acl(uiDatabase.value, false, true);
    auto original = privateFile(directory + L"\\data.sqlite", false);
    canonicalHandle(original.value, directory + L"\\data.sqlite");
    need(same(info(original.value, false), uiIdentity));
    for (const auto suffix : {L"-wal", L"-shm", L"-journal"}) {
      const auto path = directory + L"\\data.sqlite" + suffix;
      if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) { auto file = privateFile(path, false); }
      else need(GetLastError() == ERROR_FILE_NOT_FOUND);
    }
  }
};
static std::wstring argument(napi_env env, napi_value value) {
  size_t size;
  check(p_napi_get_value_string_utf16(env, value, nullptr, 0, &size));
  need(size && size <= 32760);
  std::vector<char16_t> chars(size + 1);
  check(p_napi_get_value_string_utf16(env, value, chars.data(), chars.size(), &size));
  return std::wstring(reinterpret_cast<wchar_t*>(chars.data()), size);
}
static std::wstring profileKey(const std::wstring& root, const std::wstring& profile) {
  const auto input = root + std::wstring(1, L'\0') + profile;
  int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
  need(bytes > 0);
  std::vector<unsigned char> utf8(bytes);
  need(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), reinterpret_cast<char*>(utf8.data()), bytes, nullptr, nullptr) == bytes);
  unsigned char digest[32];
  BCRYPT_ALG_HANDLE algorithm;
  need(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
  const auto status = BCryptHash(algorithm, nullptr, 0, utf8.data(), bytes, digest, sizeof(digest));
  const auto closed = BCryptCloseAlgorithmProvider(algorithm, 0);
  need(status >= 0 && closed >= 0);
  std::wstring result;
  for (unsigned char byte : digest) { result += L"0123456789abcdef"[byte >> 4]; result += L"0123456789abcdef"[byte & 15]; }
  return result;
}
static void finalize(napi_env, void* data, void*) { delete static_cast<Lease*>(data); }
static napi_value failure(napi_env env, const std::exception& error) {
  const std::string reason(error.what());
  const char* code = reason == "owner_busy" || reason == "restore_reconciliation_required" ? error.what() : "windows_access_unavailable";
  p_napi_throw_error(env, code, code); return nullptr;
}
static napi_value operation(napi_env env, napi_callback_info info) {
  try {
    napi_value self, args[1]; void* action; size_t argc = 1;
    check(p_napi_get_cb_info(env, info, &argc, args, &self, &action));
    need(argc == 0);
    Lease* lease; check(p_napi_unwrap(env, self, reinterpret_cast<void**>(&lease)));
    if (action == reinterpret_cast<void*>(1)) lease->release();
    else if (action == reinterpret_cast<void*>(2)) lease->preparePrivateUi();
    else if (action == reinterpret_cast<void*>(3)) lease->verifyPrivateUi();
    else lease->verify();
    napi_value result; check(p_napi_get_undefined(env, &result)); return result;
  } catch (const std::exception& error) { return failure(env, error); }
  catch (...) { p_napi_throw_error(env, "windows_access_unavailable", "windows_access_unavailable"); return nullptr; }
}
static napi_value factory(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3]; size_t argc = 3; void* kind;
    check(p_napi_get_cb_info(env, info, &argc, args, nullptr, &kind));
    need(argc == (kind ? 2 : 1));
    auto root = canonical(argument(env, args[0]));
    auto lease = std::make_unique<Lease>();
    if (!kind) {
      lease->ancestors(root, true);
      const auto leaf = root.substr(parent(root).size() + 1);
      need(!leaf.empty() && std::all_of(leaf.begin(), leaf.end(), [](wchar_t c) { return c >= 32 && c != 127; }));
      lease->acquire(parent(root) + L"\\.use-" + leaf + L".lock");
    } else {
      auto profile = argument(env, args[1]);
      need(profile.size() <= 64 && std::all_of(profile.begin(), profile.end(), [](wchar_t c) { return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-'; }));
      need(profile.front() != L'_' && profile.front() != L'-');
      const auto key = profileKey(root, profile);
      auto existing = root;
      while (GetFileAttributesW(existing.c_str()) == INVALID_FILE_ATTRIBUTES) { need(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND); const auto next = parent(existing); need(next != existing); existing = next; }
      lease->ancestors(existing, false);
      lease->privateDirectory(root);
      lease->privateDirectory(root + L"\\.coordination");
      const auto coordination = root + L"\\.coordination\\" + key;
      lease->privateDirectory(coordination);
      lease->ancestors(root, false);
      lease->pin(root, true, true);
      lease->pin(root + L"\\.coordination", true, true);
      lease->pin(coordination, true, true);
      lease->profilePath = root + L"\\" + profile;
      lease->acquire(coordination + L"\\profile-use.lock");
    }
    napi_value object; check(p_napi_create_object(env, &object));
    for (const auto& method : {std::pair<const char*, void*>("verify", nullptr), {"release", reinterpret_cast<void*>(1)}, {"preparePrivateUi", reinterpret_cast<void*>(2)}, {"verifyPrivateUi", reinterpret_cast<void*>(3)}}) {
      napi_value function; check(p_napi_create_function(env, method.first, NAPI_AUTO_LENGTH, operation, method.second, &function));
      check(p_napi_set_named_property(env, object, method.first, function));
    }
    check(p_napi_wrap(env, object, lease.get(), finalize, nullptr, nullptr));
    lease.release(); return object;
  } catch (const std::exception& error) { return failure(env, error); }
  catch (...) { p_napi_throw_error(env, "windows_access_unavailable", "windows_access_unavailable"); return nullptr; }
}
NAPI_MODULE_INIT() {
  HMODULE exe = GetModuleHandleW(nullptr);
#define RESOLVE(name) p_##name = reinterpret_cast<decltype(&name)>(GetProcAddress(exe, #name)); if (!p_##name) return nullptr;
  API_LIST(RESOLVE)
  for (const auto& item : {std::pair<const char*, void*>("artifactShared", nullptr), {"profileShared", reinterpret_cast<void*>(1)}}) {
    napi_value function;
    if (p_napi_create_function(env, item.first, NAPI_AUTO_LENGTH, factory, item.second, &function) != napi_ok || p_napi_set_named_property(env, exports, item.first, function) != napi_ok) return nullptr;
  }
  return exports;
}
