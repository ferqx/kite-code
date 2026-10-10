#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <utility>
#ifdef KITE_NATIVE_LAUNCHER
#include "native-bootstrap-certificate.h"
#endif

#ifndef KITE_TERMINAL_VERIFIER_SHA256
#error The trusted builder must bind the exact verifier SHA256.
#endif
#ifndef KITE_TERMINAL_VERIFIER_SIZE
#error The trusted builder must bind the exact verifier size.
#endif

static void need(bool ok) { if (!ok) throw std::runtime_error("terminal_launcher_denied"); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
};
struct Local {
  void* value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};
static std::wstring parent(const std::wstring& path) {
  if (path.size() == 3 && path[1] == L':' && path[2] == L'\\') return path;
  const auto at = path.find_last_of(L'\\');
  need(at != std::wstring::npos);
  return at == 2 ? path.substr(0, 3) : path.substr(0, at);
}
static std::wstring canonical(const std::wstring& path) {
  need(path.size() >= 3 && path.size() <= 32760 && path[1] == L':' && path[2] == L'\\');
  need(path.find(L'\0') == std::wstring::npos && path.find(L'/') == std::wstring::npos);
  wchar_t buffer[32768];
  const DWORD size = GetFullPathNameW(path.c_str(), 32768, buffer, nullptr);
  need(size && size < 32768 && std::wstring(buffer, size) == path);
  need(path.size() == 3 || path.back() != L'\\');
  for (size_t start = 3; start < path.size();) {
    const auto end = path.find(L'\\', start);
    const auto part = path.substr(start, end == std::wstring::npos ? end : end - start);
    need(!part.empty() && part.back() != L'.' && part.back() != L' ' && part.find(L':') == std::wstring::npos);
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return path;
}
static BY_HANDLE_FILE_INFORMATION identity(HANDLE h, const std::wstring& path, bool directory) {
  BY_HANDLE_FILE_INFORMATION value{};
  need(GetFileInformationByHandle(h, &value));
  need(!(value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  need(!!(value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory);
  if (!directory) need(value.nNumberOfLinks == 1);
  wchar_t buffer[32768];
  const DWORD length = GetFinalPathNameByHandleW(h, buffer, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  need(length && length < 32768);
  const std::wstring actual(buffer, length);
  need(actual.rfind(L"\\\\?\\", 0) == 0 && actual.substr(4) == path);
  return value;
}
static bool same(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}
struct Policy {
  std::vector<unsigned char> user;
  PSID sid = nullptr;
  Policy() {
    HANDLE raw = nullptr;
    need(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw));
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
    need(size && size <= 65536);
    user.resize(size);
    need(GetTokenInformation(raw, TokenUser, user.data(), size, &size));
    sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    need(IsValidSid(sid));
  }
  void verify(HANDLE h) const {
    PSID owner = nullptr;
    PACL dacl = nullptr;
    Local descriptor;
    need(GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &dacl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) == ERROR_SUCCESS);
    need(owner && dacl && EqualSid(owner, sid));
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    need(GetSecurityDescriptorControl(descriptor.value, &control, &revision));
    need(control & SE_DACL_PRESENT);
    need(dacl->AceCount <= 4096);
    for (DWORD i = 0; i < dacl->AceCount; ++i) {
      void* raw = nullptr;
      need(GetAce(dacl, i, &raw));
      const auto header = static_cast<ACE_HEADER*>(raw);
      const auto offset = static_cast<unsigned char*>(raw) - reinterpret_cast<unsigned char*>(dacl);
      need(offset >= sizeof(ACL) && offset + header->AceSize <= dacl->AclSize && header->AceSize >= sizeof(ACCESS_ALLOWED_ACE));
      need((header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) && !(header->AceFlags & ~0x1f));
      const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      PSID principal = const_cast<DWORD*>(&ace->SidStart);
      need(IsValidSid(principal) && GetLengthSid(principal) <= header->AceSize - 8);
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const bool privileged = EqualSid(principal, sid) || IsWellKnownSid(principal, WinLocalSystemSid) || IsWellKnownSid(principal, WinBuiltinAdministratorsSid);
        need(privileged || !(ace->Mask & ~0xa01200a9u));
      }
    }
  }
};
struct Pin {
  std::wstring path;
  Handle handle;
  BY_HANDLE_FILE_INFORMATION original;
  bool directory;
  Pin(std::wstring name, bool isDirectory, const Policy& policy, bool publicAcl)
    : path(std::move(name)), handle(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES | (isDirectory ? 0 : GENERIC_READ),
        isDirectory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (isDirectory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)), directory(isDirectory) {
    need(handle.value != INVALID_HANDLE_VALUE);
    original = identity(handle.value, path, directory);
    if (publicAcl) policy.verify(handle.value);
  }
  void verify(const Policy& policy, bool publicAcl) const {
    need(same(original, identity(handle.value, path, directory)));
    Pin current(path, directory, policy, publicAcl);
    need(same(original, current.original));
    if (publicAcl) policy.verify(handle.value);
  }
};
struct Hash {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<unsigned char> object;
  Hash() {
    need(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
    DWORD size = 0, received = 0;
    if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &received, 0) != 0 || !size || size > 65536) {
      BCryptCloseAlgorithmProvider(algorithm, 0); algorithm = nullptr; need(false);
    }
    object.resize(size);
    if (BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0) != 0) {
      BCryptCloseAlgorithmProvider(algorithm, 0); algorithm = nullptr; need(false);
    }
  }
  ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
};
static void verifyBytes(const Pin& file) {
  const unsigned long long expectedSize = KITE_TERMINAL_VERIFIER_SIZE;
  LARGE_INTEGER size{};
  need(GetFileSizeEx(file.handle.value, &size) && size.QuadPart >= 0 && static_cast<unsigned long long>(size.QuadPart) == expectedSize);
  Hash hash;
  unsigned char buffer[65536];
  unsigned long long total = 0;
  for (;;) {
    DWORD count = 0;
    need(ReadFile(file.handle.value, buffer, sizeof(buffer), &count, nullptr));
    if (!count) break;
    total += count;
    need(total <= expectedSize && BCryptHashData(hash.hash, buffer, count, 0) == 0);
  }
  need(total == expectedSize);
  unsigned char digest[32];
  need(BCryptFinishHash(hash.hash, digest, sizeof(digest), 0) == 0);
  const char* expected = KITE_TERMINAL_VERIFIER_SHA256;
  need(std::string(expected).size() == 64);
  const char* hex = "0123456789abcdef";
  for (size_t i = 0; i < 32; ++i) need(expected[2*i] == hex[digest[i] >> 4] && expected[2*i+1] == hex[digest[i] & 15]);
}
// MSVC argv rules: double every backslash before a quote and before the closing quote.
static std::wstring quoted(const std::wstring& argument) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t ch : argument) {
    if (ch == L'\\') { ++slashes; continue; }
    result.append(ch == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    result += ch;
  }
  result.append(slashes * 2, L'\\');
  result += L'\"';
  return result;
}
static BOOL WINAPI consoleControl(DWORD event) {
  // A handler, rather than inherited IGNORE_CTRL_C, keeps only this parent alive.
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}
struct Attributes {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  Attributes() {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    need(size && size <= 65536);
    storage.resize(size);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    need(InitializeProcThreadAttributeList(list, 1, 0, &size));
  }
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};
int wmain(int argc, wchar_t** argv) {
  try {
    for (const wchar_t* name : {L"NODE_PATH", L"NODE_OPTIONS", L"BUN_OPTIONS", L"BUN_BE_BUN", L"ELECTRON_RUN_AS_NODE"}) {
      // Deleting an already absent variable is also a clean environment.
      need(SetEnvironmentVariableW(name, nullptr) || GetLastError() == ERROR_ENVVAR_NOT_FOUND);
    }
    need(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32));
    need(SetConsoleCtrlHandler(nullptr, FALSE));
    need(SetConsoleCtrlHandler(consoleControl, TRUE));
    wchar_t module[32768];
    const DWORD length = GetModuleFileNameW(nullptr, module, 32768);
    need(length && length < 32768);
    const auto executable = canonical(std::wstring(module, length));
    const auto bin = parent(executable), root = parent(bin);
    need(bin.substr(bin.find_last_of(L'\\') + 1) == L"bin");
    const auto name = executable.substr(executable.find_last_of(L'\\') + 1);
#ifdef KITE_NATIVE_LAUNCHER
    need(name == L"kite.exe" || name == L"kite-tui.exe" || name == L"kite-desktop.exe");
    const auto helperPath = bin + L"\\native-verifier.exe";
#else
    need(name == L"kite.exe" || name == L"kite-tui.exe");
    const auto helperPath = bin + L"\\terminal-verifier.exe";
#endif
    Policy policy;
    std::vector<Pin> ancestors;
    for (auto path = bin;; path = parent(path)) {
      need(ancestors.size() < 256);
      ancestors.emplace_back(path, true, policy, ancestors.size() < 2);
      if (parent(path) == path) break;
    }
    Pin self(executable, false, policy, true), helper(helperPath, false, policy, true);
    verifyBytes(helper);
    for (size_t i = 0; i < ancestors.size(); ++i) ancestors[i].verify(policy, i < 2);
    self.verify(policy, true);
    helper.verify(policy, true);
    std::wstring command = quoted(helperPath) + L" " + quoted(name == L"kite.exe" ? L"cli" : name == L"kite-tui.exe" ? L"tui" : L"desktop") + L" " + quoted(root);
#ifdef KITE_NATIVE_LAUNCHER
    // Strong native owner remains alive through the actual helper exit.
    auto* certificate = new NativeBootstrapCertificate(policy.sid);
    command += L" " + quoted(certificate->path);
#endif
    for (int i = 1; i < argc; ++i) command += L" " + quoted(argv[i]);
    need(command.size() < 32767);
    // Explicit inherited-handle allowlist preserves stdio without handing over any pin.
    std::vector<Handle> streams;
    std::vector<HANDLE> inherited;
    for (const DWORD id : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
      const HANDLE original = GetStdHandle(id);
      need(original && original != INVALID_HANDLE_VALUE);
      HANDLE duplicate = nullptr;
      need(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS));
      streams.emplace_back(duplicate);
      inherited.push_back(duplicate);
    }
    Attributes attributes;
    need(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr));
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes.list;
    PROCESS_INFORMATION child{};
    need(CreateProcessW(helperPath.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &child));
    Handle process(child.hProcess), thread(child.hThread);
#ifdef KITE_NATIVE_LAUNCHER
    try { certificate->bind(process.value); }
    catch (...) { while (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) Sleep(10); certificate->close(); throw; }
#endif
    // Unknown wait failure cannot release pins while this exact helper may still consume them.
    while (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) Sleep(10);
    DWORD exit = 1;
    need(GetExitCodeProcess(process.value, &exit));
#ifdef KITE_NATIVE_LAUNCHER
    certificate->close();
    delete certificate;
#endif
    return static_cast<int>(exit);
  } catch (...) {
#ifdef KITE_NATIVE_LAUNCHER
    const char message[] = "native_launcher_denied\r\n";
#else
    const char message[] = "terminal_launcher_denied\r\n";
#endif
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, sizeof(message) - 1, &written, nullptr);
    return 1;
  }
}
