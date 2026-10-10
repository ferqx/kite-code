#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define NAPI_VERSION 8
#define NAPI_EXTERN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <tlhelp32.h>
#include "node_api.h"
#include <algorithm>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>
#include <set>
#include <cmath>

// All signatures and registration types come from the pinned official Node-API headers.
#define API_LIST(X) X(napi_get_cb_info) X(napi_get_value_string_utf16) X(napi_create_object) X(napi_create_function) X(napi_set_named_property) X(napi_wrap) X(napi_unwrap) X(napi_get_undefined) X(napi_throw_error) X(napi_get_global) X(napi_get_named_property) X(napi_call_function) X(napi_create_string_utf8) X(napi_create_string_utf16) X(napi_get_property_names) X(napi_get_array_length) X(napi_get_element) X(napi_is_array) X(napi_get_value_double)
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
    need(std::all_of(part.begin(), part.end(), [](wchar_t c) { return c >= 32 && c != 127 && c != L'<' && c != L'>' && c != L'"' && c != L'|' && c != L'?' && c != L'*'; }));
    auto device = part.substr(0, part.find(L'.'));
    for (auto& c : device) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
    need(device != L"CON" && device != L"PRN" && device != L"AUX" && device != L"NUL");
    need(!(device.size() == 4 && (device.substr(0, 3) == L"COM" || device.substr(0, 3) == L"LPT") &&
      ((device[3] >= L'1' && device[3] <= L'9') || device[3] == L'\u00b9' || device[3] == L'\u00b2' || device[3] == L'\u00b3')));
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
  bool directory = true;
  bool empty = false;
};
struct Probe {
  Handle handle;
  Handle event;
  OVERLAPPED operation{};
  bool pending = false;
  bool enumeration = false;
  unsigned char bytes[32]{};
  explicit Probe(HANDLE raw) : handle(raw) {}
  void close() {
    if (pending) {
      if (!CancelIoEx(handle.value, &operation) && GetLastError() != ERROR_NOT_FOUND)
        throw std::runtime_error("windows_access_close_unknown");
      DWORD transferred = 0;
      if (!GetOverlappedResult(handle.value, &operation, &transferred, FALSE)) {
        const DWORD error = GetLastError();
        if (error != ERROR_OPERATION_ABORTED && error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA)
          throw std::runtime_error("windows_access_close_unknown");
      }
      pending = false;
    }
    event.close();
    if (enumeration && handle.value != INVALID_HANDLE_VALUE) { need(FindClose(handle.value)); handle.value = INVALID_HANDLE_VALUE; }
    else handle.close();
  }
};
struct Lease {
  Policy policy;
  std::vector<Entry> entries;
  std::vector<std::unique_ptr<Probe>> probes;
  Probe& probe(HANDLE raw) {
    need(raw != INVALID_HANDLE_VALUE && raw != nullptr);
    probes.push_back(std::make_unique<Probe>(raw));
    return *probes.back();
  }
  void closeProbe(Probe& value) {
    value.close();
    const auto* original = &value;
    probes.erase(std::remove_if(probes.begin(), probes.end(), [original](const auto& item) { return item.get() == original; }), probes.end());
  }
  Probe& privateProbe(const std::wstring& path) {
    auto& held = probe(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    info(held.handle.value, false); policy.acl(held.handle.value, false, true);
    return held;
  }
  Handle lock;
  Handle innerLock;
  OVERLAPPED innerRegion{};
  std::wstring innerLockPath;
  BY_HANDLE_FILE_INFORMATION innerLockIdentity{};
  bool innerAcquired = false;
  bool candidate = false;
  Handle broker;
  Handle processSnapshot;
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
  void verifyEmpty(const std::wstring& path) {
    WIN32_FIND_DATAW data{};
    const HANDLE raw = FindFirstFileW((path + L"\\*").c_str(), &data);
    if (raw == INVALID_HANDLE_VALUE) { need(GetLastError() == ERROR_FILE_NOT_FOUND); return; }
    auto& held = probe(raw); held.enumeration = true;
    for (size_t count = 0;; ++count) {
      need(count < 2 && (std::wstring(data.cFileName) == L"." || std::wstring(data.cFileName) == L".."));
      if (!FindNextFileW(raw, &data)) { need(GetLastError() == ERROR_NO_MORE_FILES); break; }
    }
    closeProbe(held);
  }
  void pin(const std::wstring& path, bool privateObject, bool checkAcl) {
    auto held = openDirectory(path);
    entries.push_back({path, std::move(held), {}, privateObject, checkAcl});
    auto& entry = entries.back();
    canonicalHandle(entry.handle.value, path);
    entry.identity = info(entry.handle.value, true);
    if (checkAcl) policy.acl(entry.handle.value, true, privateObject);
  }
  HANDLE pinFile(const std::wstring& path, bool privateObject) {
    auto raw = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    need(raw != INVALID_HANDLE_VALUE);
    entries.push_back({path, Handle(raw), {}, privateObject, true, false});
    auto& entry = entries.back();
    canonicalHandle(raw, path);
    entry.identity = info(raw, false);
    policy.acl(raw, false, privateObject);
    return raw;
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
    auto& held = probe(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    info(held.handle.value, true);
    policy.acl(held.handle.value, true, true); closeProbe(held);
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
    auto& held = probe(raw);
    info(held.handle.value, false);
    policy.acl(held.handle.value, false, true);
    Handle result(std::move(held.handle)); closeProbe(held);
    return result;
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
    if (!candidate) verify();
  }
  void verify() {
    need(!closed && acquired && lock.value != INVALID_HANDLE_VALUE);
    for (auto& entry : entries) {
      need(entry.handle.value != INVALID_HANDLE_VALUE && same(info(entry.handle.value, entry.directory), entry.identity));
      auto& fresh = probe(CreateFileW(entry.path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
        entry.directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (entry.directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
      canonicalHandle(fresh.handle.value, entry.path);
      need(same(info(fresh.handle.value, entry.directory), entry.identity));
      if (entry.checkAcl) { policy.acl(entry.handle.value, entry.directory, entry.privateObject); policy.acl(fresh.handle.value, entry.directory, entry.privateObject); }
      closeProbe(fresh);
      if (entry.empty) verifyEmpty(entry.path);
    }
    auto& fresh = privateProbe(lockPath);
    need(same(info(lock.value, false), lockIdentity) && same(info(fresh.handle.value, false), lockIdentity));
    closeProbe(fresh);
    if (candidate) {
      need(innerAcquired && innerLock.value != INVALID_HANDLE_VALUE);
      auto& original = privateProbe(innerLockPath);
      need(same(info(innerLock.value, false), innerLockIdentity) && same(info(original.handle.value, false), innerLockIdentity));
      closeProbe(original);
    }
    if (!profilePath.empty()) {
      const auto journal = parent(lockPath) + L"\\restore-journal.json";
      if (GetFileAttributesW(journal.c_str()) != INVALID_FILE_ATTRIBUTES) throw std::runtime_error("restore_reconciliation_required");
      need(GetLastError() == ERROR_FILE_NOT_FOUND);
      const auto attributes = GetFileAttributesW(profilePath.c_str());
      if (attributes != INVALID_FILE_ATTRIBUTES) {
        auto& profile = probe(CreateFileW(profilePath.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        info(profile.handle.value, true); closeProbe(profile);
      }
      else need(GetLastError() == ERROR_FILE_NOT_FOUND);
    }
  }
  void release() {
    if (closed) return;
    bool failure = false;
    for (auto& probe : probes) try { probe->close(); } catch (...) { failure = true; }
    if (failure) throw std::runtime_error("windows_access_close_unknown");
    probes.clear();
    try { processSnapshot.close(); } catch (...) { failure = true; }
    try { broker.close(); } catch (...) { failure = true; }
    try { uiDatabase.close(); } catch (...) { failure = true; }
    for (auto it = entries.rbegin(); it != entries.rend(); ++it)
      try { it->handle.close(); } catch (...) { failure = true; }
    if (failure) throw std::runtime_error("windows_access_close_unknown");
    if (candidate) {
      if (innerLock.value != INVALID_HANDLE_VALUE) {
        if (innerAcquired && !UnlockFileEx(innerLock.value, 0, 1, 0, &innerRegion)) failure = true;
        if (CloseHandle(innerLock.value)) { innerLock.value = INVALID_HANDLE_VALUE; innerAcquired = false; }
        else failure = true;
      }
      if (failure) throw std::runtime_error("windows_access_close_unknown");
    }
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
    closed = lock.value == INVALID_HANDLE_VALUE && innerLock.value == INVALID_HANDLE_VALUE && broker.value == INVALID_HANDLE_VALUE && processSnapshot.value == INVALID_HANDLE_VALUE && uiDatabase.value == INVALID_HANDLE_VALUE && std::all_of(entries.begin(), entries.end(), [](const Entry& entry) { return entry.handle.value == INVALID_HANDLE_VALUE; });
    if (failure || !closed) throw std::runtime_error("windows_access_close_unknown");
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
    auto& original = privateProbe(directory + L"\\data.sqlite");
    canonicalHandle(original.handle.value, directory + L"\\data.sqlite");
    need(same(info(original.handle.value, false), uiIdentity)); closeProbe(original);
    for (const auto suffix : {L"-wal", L"-shm", L"-journal"}) {
      const auto path = directory + L"\\data.sqlite" + suffix;
      if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) { auto& file = privateProbe(path); closeProbe(file); }
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
static napi_value property(napi_env env, napi_value value, const char* name) {
  napi_value result; check(p_napi_get_named_property(env, value, name, &result)); return result;
}
static napi_value element(napi_env env, napi_value value, uint32_t index) {
  napi_value result; check(p_napi_get_element(env, value, index, &result)); return result;
}
static uint32_t arrayLength(napi_env env, napi_value value) {
  bool array; check(p_napi_is_array(env, value, &array)); need(array);
  uint32_t size; check(p_napi_get_array_length(env, value, &size)); return size;
}
static void keys(napi_env env, napi_value value, std::set<std::wstring> expected) {
  bool array; check(p_napi_is_array(env, value, &array)); need(!array);
  napi_value names; check(p_napi_get_property_names(env, value, &names));
  const auto count = arrayLength(env, names); need(count == expected.size());
  for (uint32_t i = 0; i < count; ++i) need(expected.erase(argument(env, element(env, names, i))) == 1);
  need(expected.empty());
}
static std::wstring lower(napi_env env, const std::wstring& text) {
  napi_value global, receiver, result;
  check(p_napi_get_global(env, &global));
  check(p_napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &receiver));
  auto method = property(env, property(env, property(env, global, "String"), "prototype"), "toLowerCase");
  check(p_napi_call_function(env, receiver, method, 0, nullptr, &result));
  return argument(env, result);
}
static std::vector<unsigned char> utf8(const std::wstring& value) {
  const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  need(count > 0); std::vector<unsigned char> bytes(count);
  need(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), reinterpret_cast<char*>(bytes.data()), count, nullptr, nullptr) == count);
  return bytes;
}
static std::wstring digestBytes(const std::vector<unsigned char>& bytes) {
  BCRYPT_ALG_HANDLE algorithm; need(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
  unsigned char digest[32];
  const auto status = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), digest, 32);
  const auto closed = BCryptCloseAlgorithmProvider(algorithm, 0); need(status >= 0 && closed >= 0);
  std::wstring result; for (const auto byte : digest) { result += L"0123456789abcdef"[byte >> 4]; result += L"0123456789abcdef"[byte & 15]; } return result;
}
static bool hashValue(const std::wstring& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
static uint64_t decimal(const std::wstring& value) {
  need(!value.empty() && value.size() <= 9 && (value.size() == 1 || value[0] != L'0'));
  uint64_t result = 0; for (const auto c : value) { need(c >= L'0' && c <= L'9'); result = result * 10 + c - L'0'; }
  need(result <= 512ull * 1048576); return result;
}
static std::vector<unsigned char> readFile(HANDLE handle, uint64_t maximum) {
  const auto before = info(handle, false);
  const uint64_t size = (static_cast<uint64_t>(before.nFileSizeHigh) << 32) | before.nFileSizeLow;
  need(size <= maximum); LARGE_INTEGER zero{}; need(SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN));
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  for (size_t offset = 0; offset < bytes.size();) {
    DWORD count; need(ReadFile(handle, bytes.data() + offset, static_cast<DWORD>(std::min<size_t>(262144, bytes.size() - offset)), &count, nullptr));
    need(count && count <= bytes.size() - offset); offset += count;
  }
  unsigned char eof; DWORD count; need(ReadFile(handle, &eof, 1, &count, nullptr) && count == 0);
  const auto after = info(handle, false);
  need(same(before, after) && before.nFileSizeHigh == after.nFileSizeHigh && before.nFileSizeLow == after.nFileSizeLow &&
    before.ftLastWriteTime.dwHighDateTime == after.ftLastWriteTime.dwHighDateTime && before.ftLastWriteTime.dwLowDateTime == after.ftLastWriteTime.dwLowDateTime);
  return bytes;
}
static napi_value json(napi_env env, HANDLE handle, uint64_t maximum = 16384) {
  need(maximum <= 8 * 1048576);
  auto bytes = readFile(handle, maximum); need(!bytes.empty());
  // Reject malformed UTF-8 before invoking the original Main JSON parser.
  need(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<char*>(bytes.data()), static_cast<int>(bytes.size()), nullptr, 0) > 0);
  napi_value global, text, result; check(p_napi_get_global(env, &global));
  check(p_napi_create_string_utf8(env, reinterpret_cast<char*>(bytes.data()), bytes.size(), &text));
  auto object = property(env, global, "JSON"), parse = property(env, object, "parse");
  check(p_napi_call_function(env, object, parse, 1, &text, &result)); return result;
}
static uint64_t fileTime(HANDLE process) {
  FILETIME creation, exit, kernel, user; need(GetProcessTimes(process, &creation, &exit, &kernel, &user));
  const auto value = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime; need(value != 0); return value;
}
static void originalBroker(Lease& lease, const std::wstring& expected) {
  lease.processSnapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); need(lease.processSnapshot.value != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W row{}; row.dwSize = sizeof(row); DWORD parentPid = 0; bool complete = false;
  BOOL next = Process32FirstW(lease.processSnapshot.value, &row);
  for (size_t count = 0; count < 65536; ++count) {
    if (!next) { complete = GetLastError() == ERROR_NO_MORE_FILES; break; }
    if (row.th32ProcessID == GetCurrentProcessId()) { need(parentPid == 0); parentPid = row.th32ParentProcessID; }
    next = Process32NextW(lease.processSnapshot.value, &row);
  }
  need(complete && parentPid != 0); lease.processSnapshot.close();
  const auto raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parentPid); need(raw);
  lease.broker = Handle(raw);
  need(GetProcessId(lease.broker.value) == parentPid);
  need(fileTime(lease.broker.value) <= fileTime(GetCurrentProcess()) && WaitForSingleObject(lease.broker.value, 0) == WAIT_TIMEOUT);
  wchar_t path[32768]; DWORD length = 32768;
  need(QueryFullProcessImageNameW(lease.broker.value, 0, path, &length) && length > 0 && length < 32768);
  need(canonical(std::wstring(path, length)) == expected);
}
static void certificate(Lease& lease, const std::wstring& path, const std::wstring& prefix,
  const char* magic, HANDLE certified, const std::wstring& serverImage, bool brokerServer) {
  const auto stem = L"\\\\.\\pipe\\" + prefix;
  need(path.size() == stem.size() + 32 && path.substr(0, stem.size()) == stem &&
    std::all_of(path.begin() + stem.size(), path.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); }));
  need(WaitNamedPipeW(path.c_str(), 5000));
  auto& pipe = lease.probe(CreateFileW(path.c_str(), 0x120089u,
    0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  ULONG pid = 0; need(GetNamedPipeServerProcessId(pipe.handle.value, &pid) && pid != 0);
  auto& server = lease.probe(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  need(GetProcessId(server.handle.value) == pid && WaitForSingleObject(server.handle.value, 0) == WAIT_TIMEOUT);
  const auto born = fileTime(server.handle.value);
  need(born <= fileTime(certified));
  if (brokerServer) need(pid == GetProcessId(lease.broker.value) && born == fileTime(lease.broker.value));
  wchar_t image[32768]; DWORD length = 32768;
  need(QueryFullProcessImageNameW(server.handle.value, 0, image, &length) && length && length < 32768 && canonical(std::wstring(image, length)) == serverImage);
  pipe.event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); need(pipe.event.value != nullptr && pipe.event.value != INVALID_HANDLE_VALUE);
  pipe.operation.hEvent = pipe.event.value;
  DWORD total = 0;
  const ULONGLONG deadline = GetTickCount64() + 5000;
  while (total < 32) {
    const HANDLE event = pipe.operation.hEvent;
    pipe.operation = {}; pipe.operation.hEvent = event; need(ResetEvent(event));
    DWORD count = 0;
    const BOOL immediate = ReadFile(pipe.handle.value, pipe.bytes + total, 32 - total, &count, &pipe.operation);
    if (!immediate) {
      need(GetLastError() == ERROR_IO_PENDING); pipe.pending = true;
      const auto now = GetTickCount64();
      if (now >= deadline || WaitForSingleObject(event, static_cast<DWORD>(deadline - now)) != WAIT_OBJECT_0)
        throw std::runtime_error("windows_access_close_unknown");
      const BOOL completed = GetOverlappedResult(pipe.handle.value, &pipe.operation, &count, FALSE);
      if (!completed) {
        const DWORD error = GetLastError();
        if (error != ERROR_OPERATION_ABORTED && error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA)
          throw std::runtime_error("windows_access_close_unknown");
      }
      pipe.pending = false; need(completed);
    }
    need(count > 0 && count <= 32 - total); total += count;
  }
  DWORD available = 0; need(PeekNamedPipe(pipe.handle.value, nullptr, 0, nullptr, &available, nullptr) && available == 0);
  need(total == 32);
  for (unsigned i = 0; i < 8; ++i) need(pipe.bytes[i] == static_cast<unsigned char>(magic[i]));
  uint64_t certificatePid = 0, certificateBirth = 0;
  for (unsigned i = 0; i < 4; ++i) certificatePid |= static_cast<uint64_t>(pipe.bytes[8+i]) << (8*i);
  for (unsigned i = 0; i < 8; ++i) certificateBirth |= static_cast<uint64_t>(pipe.bytes[16+i]) << (8*i);
  for (unsigned i : {12u,13u,14u,15u,24u,25u,26u,27u,28u,29u,30u,31u}) need(pipe.bytes[i] == 0);
  need(certificatePid == GetProcessId(certified) && certificateBirth == fileTime(certified));
  need(WaitForSingleObject(server.handle.value, 0) == WAIT_TIMEOUT && fileTime(server.handle.value) == born);
  lease.closeProbe(pipe); lease.closeProbe(server);
}
static void candidate(napi_env env, Lease& lease, const std::wstring& root, const std::wstring& prefix,
  const std::wstring& id, napi_value files, napi_value handoff) {
  keys(env, handoff, {L"launcherPipe", L"mainPipe"});
  const auto launcherPipe = argument(env, property(env, handoff, "launcherPipe"));
  const auto mainPipe = argument(env, property(env, handoff, "mainPipe"));
  need(hashValue(id) && root == prefix + L"\\releases\\" + id);
  lease.candidate = true; lease.ancestors(root, true);
  lease.pin(prefix, false, true); lease.pin(parent(prefix), false, true);
  const auto normalized = lower(env, prefix);
  const auto coordination = parent(prefix) + L"\\.kite-install-coordination-" + digestBytes(utf8(normalized));
  lease.pin(coordination, true, true);
  auto marker = json(env, lease.pinFile(coordination + L"\\installation.json", true));
  keys(env, marker, {L"version", L"prefix"}); double version;
  check(p_napi_get_value_double(env, property(env, marker, "version"), &version));
  need(version == 1 && argument(env, property(env, marker, "prefix")) == normalized);
  auto installed = json(env, lease.pinFile(prefix + L"\\.kite-native-install.json", true));
  keys(env, installed, {L"version", L"root", L"bootstrap"});
  check(p_napi_get_value_double(env, property(env, installed, "version"), &version));
  need(version == 2 && argument(env, property(env, installed, "root")) == prefix);
  auto bootstrap = property(env, installed, "bootstrap"); keys(env, bootstrap, {L"candidateId", L"files"});
  need(hashValue(argument(env, property(env, bootstrap, "candidateId"))));
  auto frontdoors = property(env, bootstrap, "files"); need(arrayLength(env, frontdoors) == 4);
  const wchar_t* names[] = {L"kite.exe", L"kite-tui.exe", L"kite-desktop.exe", L"native-verifier.exe"};
  lease.pin(prefix + L"\\bin", false, true);
  for (uint32_t i = 0; i < 4; ++i) {
    auto file = element(env, frontdoors, i); keys(env, file, {L"name", L"size", L"sha256"});
    need(argument(env, property(env, file, "name")) == names[i]); double size;
    check(p_napi_get_value_double(env, property(env, file, "size"), &size));
    need(size > 0 && std::floor(size) == size && size <= 512 * 1048576);
    const auto hash = argument(env, property(env, file, "sha256")); need(hashValue(hash));
    const auto bytes = readFile(lease.pinFile(prefix + L"\\bin\\" + names[i], true), 512 * 1048576);
    need(bytes.size() == size && digestBytes(bytes) == hash);
  }
  originalBroker(lease, prefix + L"\\bin\\native-verifier.exe");
  const auto length = arrayLength(env, files); need(length > 0 && length <= 65536);
  std::set<std::wstring> paths, directories;
  HANDLE nativeManifest = INVALID_HANDLE_VALUE;
  for (uint32_t i = 0; i < length; ++i) {
    auto file = element(env, files, i); need(arrayLength(env, file) == 3);
    const auto relative = argument(env, element(env, file, 0));
    need(relative.front() != L'/' && relative.back() != L'/' && relative.find(L'\\') == std::wstring::npos && relative.find(L':') == std::wstring::npos &&
      relative.find(L'\0') == std::wstring::npos && relative.find(L"//") == std::wstring::npos);
    auto local = relative; std::replace(local.begin(), local.end(), L'/', L'\\');
    const auto path = canonical(root + L"\\" + local); need(paths.insert(path).second);
    auto directory = parent(path);
    while (directory != root) { need(directory.size() > root.size()); if (directories.insert(directory).second) lease.pin(directory, false, true); directory = parent(directory); }
    const auto hash = argument(env, element(env, file, 1)); need(hashValue(hash));
    const auto size = decimal(argument(env, element(env, file, 2)));
    const auto handle = lease.pinFile(path, false);
    if (path == root + L"\\native-manifest.json") nativeManifest = handle;
    const auto bytes = readFile(handle, 512 * 1048576);
    need(bytes.size() == size && digestBytes(bytes) == hash);
  }
  need(paths.count(root + L"\\native-manifest.json") && paths.count(root + L"\\terminal\\terminal-manifest.json"));
  auto declared = property(env, json(env, nativeManifest, 8 * 1048576), "directories");
  const auto directoryCount = arrayLength(env, declared); need(directoryCount <= 65536);
  std::set<std::wstring> emptyPaths;
  for (uint32_t i = 0; i < directoryCount; ++i) {
    auto relative = argument(env, element(env, declared, i));
    need(relative.rfind(L"electron/", 0) == 0 && relative.back() != L'/' && relative.find(L"//") == std::wstring::npos &&
      relative.find(L'\\') == std::wstring::npos && relative.find(L':') == std::wstring::npos && relative.find(L'\0') == std::wstring::npos);
    std::replace(relative.begin(), relative.end(), L'/', L'\\');
    const auto path = canonical(root + L"\\" + relative);
    need(emptyPaths.insert(path).second && !paths.count(path) && !directories.count(path));
    auto ancestor = parent(path);
    while (ancestor != root) { need(ancestor.size() > root.size()); if (directories.insert(ancestor).second) lease.pin(ancestor, false, true); ancestor = parent(ancestor); }
    lease.pin(path, false, true); lease.entries.back().empty = true; lease.verifyEmpty(path);
  }
  lease.acquire(coordination + L"\\use-" + id + L".lock");
  lease.innerLockPath = coordination + L"\\use-" + digestBytes(utf8(id + std::wstring(1, L'\0') + L"terminal")) + L".lock";
  lease.innerLock = lease.privateFile(lease.innerLockPath, true); lease.innerLockIdentity = info(lease.innerLock.value, false);
  if (!LockFileEx(lease.innerLock.value, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &lease.innerRegion)) {
    if (GetLastError() == ERROR_LOCK_VIOLATION) throw std::runtime_error("owner_busy"); need(false);
  }
  lease.innerAcquired = true; lease.verify();
  certificate(lease, launcherPipe, L"kite-native-launch-", "KITELCH1", lease.broker.value, prefix + L"\\bin\\kite-desktop.exe", false);
  certificate(lease, mainPipe, L"kite-native-main-", "KITEMAI1", GetCurrentProcess(), prefix + L"\\bin\\native-verifier.exe", true);
  need(WaitForSingleObject(lease.broker.value, 0) == WAIT_TIMEOUT); lease.broker.close();
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
static std::vector<std::unique_ptr<Lease>> failedLeases;
static void finalize(napi_env, void* data, void*) {
  std::unique_ptr<Lease> lease(static_cast<Lease*>(data));
  try { lease->release(); } catch (...) { failedLeases.push_back(std::move(lease)); }
}
static napi_value failure(napi_env env, const std::exception& error) {
  const std::string reason(error.what());
  const char* code = reason == "owner_busy" || reason == "restore_reconciliation_required" || reason == "windows_access_close_unknown" ? error.what() : "windows_access_unavailable";
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
  std::unique_ptr<Lease> lease;
  try {
    napi_value args[6]; size_t argc = 6; void* kind;
    check(p_napi_get_cb_info(env, info, &argc, args, nullptr, &kind));
    need(argc == (kind == reinterpret_cast<void*>(2) ? 5 : kind ? 2 : 1));
    auto root = canonical(argument(env, args[0]));
    lease = std::make_unique<Lease>();
    if (kind == reinterpret_cast<void*>(2)) {
      candidate(env, *lease, root, canonical(argument(env, args[1])), argument(env, args[2]), args[3], args[4]);
    } else if (!kind) {
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
  } catch (const std::exception& error) {
    if (lease) { try { lease->release(); } catch (...) { failedLeases.push_back(std::move(lease)); p_napi_throw_error(env, "windows_access_close_unknown", "windows_access_close_unknown"); return nullptr; } }
    return failure(env, error);
  }
  catch (...) {
    if (lease) { try { lease->release(); } catch (...) { failedLeases.push_back(std::move(lease)); p_napi_throw_error(env, "windows_access_close_unknown", "windows_access_close_unknown"); return nullptr; } }
    p_napi_throw_error(env, "windows_access_unavailable", "windows_access_unavailable"); return nullptr;
  }
}
NAPI_MODULE_INIT() {
  HMODULE exe = GetModuleHandleW(nullptr);
#define RESOLVE(name) p_##name = reinterpret_cast<decltype(&name)>(GetProcAddress(exe, #name)); if (!p_##name) return nullptr;
  API_LIST(RESOLVE)
  for (const auto& item : {std::pair<const char*, void*>("artifactShared", nullptr), {"profileShared", reinterpret_cast<void*>(1)}, {"candidateShared", reinterpret_cast<void*>(2)}}) {
    napi_value function;
    if (p_napi_create_function(env, item.first, NAPI_AUTO_LENGTH, factory, item.second, &function) != napi_ok || p_napi_set_named_property(env, exports, item.first, function) != napi_ok) return nullptr;
  }
  return exports;
}
