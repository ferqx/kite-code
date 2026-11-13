#include <windows.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <zstd.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cwchar>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "location-dialog.h"
#include "payload.h"
#include "shell-integration.h"

namespace {

const wchar_t title[] = L"Kite 桌面版安装";

struct Handle {
  HANDLE value;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { close(); }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
  void close() {
    if (*this) CloseHandle(value);
    value = nullptr;
  }
};

void require(bool success, const wchar_t* message) {
  if (!success) throw std::wstring(message);
}

struct Bytes {
  const unsigned char* data;
  DWORD size;
};

Bytes resource(WORD id) {
  const HRSRC entry = FindResourceW(nullptr, MAKEINTRESOURCEW(id), RT_RCDATA);
  require(entry != nullptr, L"安装文件缺少所需资源。");
  const DWORD size = SizeofResource(nullptr, entry);
  const auto* data = static_cast<const unsigned char*>(LockResource(LoadResource(nullptr, entry)));
  require(size != 0 && data != nullptr, L"无法读取安装资源。");
  return {data, size};
}

bool matchesHash(Bytes bytes, const wchar_t* expected) {
  BCRYPT_ALG_HANDLE provider = nullptr;
  if (BCryptOpenAlgorithmProvider(&provider, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return false;
  std::array<unsigned char, 32> digest{};
  const NTSTATUS status = BCryptHash(provider, nullptr, 0, const_cast<PUCHAR>(bytes.data),
                                    bytes.size, digest.data(), static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(provider, 0);
  if (status != 0) return false;
  const wchar_t hex[] = L"0123456789abcdef";
  for (size_t i = 0; i < digest.size(); ++i) {
    if (expected[2 * i] != hex[digest[i] >> 4] || expected[2 * i + 1] != hex[digest[i] & 15])
      return false;
  }
  return true;
}

void reportBytes(SetupProgress* progress, ULONGLONG& previous, uint64_t bytes, uint64_t total) {
  if (!progress || !progress->visible()) return;
  const auto now = GetTickCount64();
  if (bytes && bytes != total && now - previous < 125) return;
  previous = now;
  progress->count(bytes, total, SetupCount::bytes);
  progress->pump();
}

std::vector<unsigned char> readRuntime(Bytes archive, SetupProgress& progress) {
  std::unique_ptr<ZSTD_DCtx, decltype(&ZSTD_freeDCtx)> decoder(ZSTD_createDCtx(), ZSTD_freeDCtx);
  require(decoder != nullptr &&
          !ZSTD_isError(ZSTD_DCtx_setParameter(decoder.get(), ZSTD_d_windowLogMax, 27)),
          L"无法初始化安装包解压。");
  ZSTD_inBuffer input{archive.data, archive.size, 0};
  std::vector<unsigned char> runtime(runtimeSize);
  std::vector<unsigned char> block(ZSTD_DStreamOutSize());
  size_t offset = 0;
  const size_t end = runtimeOffset + runtimeSize;
  ULONGLONG previous = 0;
  reportBytes(&progress, previous, 0, end);
  while (offset < end) {
    ZSTD_outBuffer output{block.data(), block.size(), 0};
    const size_t before = input.pos;
    const size_t result = ZSTD_decompressStream(decoder.get(), &output, &input);
    require(!ZSTD_isError(result) && (input.pos != before || output.pos != 0),
            L"无法解压包内运行时。");
    const size_t first = (std::max)(offset, runtimeOffset);
    const size_t last = (std::min)(offset + output.pos, end);
    if (last > first) {
      std::copy_n(block.data() + (first - offset), last - first, runtime.data() + (first - runtimeOffset));
    }
    offset += output.pos;
    require(result != 0 || offset >= end, L"安装包中的运行时不完整。");
    reportBytes(&progress, previous, (std::min)(offset, end), end);
  }
  require(matchesHash({runtime.data(), static_cast<DWORD>(runtime.size())}, runtimeHash),
          L"包内运行时校验失败。");
  return runtime;
}

std::wstring temporaryDirectory() {
  std::vector<wchar_t> path(32768);
  const DWORD size = GetTempPathW(static_cast<DWORD>(path.size()), path.data());
  require(size >= 3 && size < path.size(), L"无法定位当前用户的安装暂存目录。");
  std::wstring directory(path.data(), size);
  while (directory.size() > 3 && directory.back() == L'\\') directory.pop_back();
  return directory;
}

void verifyPhysicalPath(const std::wstring& path, HANDLE handle, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  require(GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
          bool(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
          !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), L"安装文件或目录的类型无效。");
  std::vector<wchar_t> buffer(32768);
  const DWORD count = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), 0);
  require(count > 4 && count < buffer.size() && wcsncmp(buffer.data(), L"\\\\?\\", 4) == 0,
          L"无法核对安装暂存目录。");
  if (_wcsicmp(path.c_str(), buffer.data() + 4) != 0)
    throw std::wstring(L"安装暂存目录包含路径别名。\n\n") + path + L"\n" + (buffer.data() + 4);
}

struct Stage {
  std::wstring path;
  bool owned = false;
  bool clean() {
    if (!owned) return true;
    for (const wchar_t* file : {L"bundle.tar.zst", L"node.exe", L"install.mjs", L"runtime-native.node",
                              L"install.log", L"Kite Desktop.exe"}) {
      if (!DeleteFileW((path + L"\\" + file).c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) return false;
    }
    if (!RemoveDirectoryW(path.c_str())) return false;
    owned = false;
    return true;
  }
  ~Stage() { clean(); }
};

void createStage(Stage& stage, const std::wstring& parent,
                 const wchar_t* stem = L".kite-desktop-setup-") {
  HANDLE raw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), L"无法识别当前用户。");
  Handle token(raw);
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  require(size && size <= 65536, L"无法识别当前用户。");
  std::vector<unsigned char> info(size);
  require(GetTokenInformation(token.value, TokenUser, info.data(), size, &size), L"无法识别当前用户。");
  wchar_t* sid = nullptr;
  require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid, &sid),
          L"无法读取当前用户权限。");
  std::unique_ptr<wchar_t, decltype(&LocalFree)> userSid(sid, LocalFree);
  const std::wstring descriptor = std::wstring(L"O:") + sid + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
  PSECURITY_DESCRIPTOR rawDescriptor = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(), SDDL_REVISION_1,
          &rawDescriptor, nullptr), L"无法创建私有安装暂存目录。");
  std::unique_ptr<void, decltype(&LocalFree)> security(rawDescriptor, LocalFree);
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), security.get(), FALSE};
  GUID id{};
  wchar_t text[40]{};
  require(SUCCEEDED(CoCreateGuid(&id)) && StringFromGUID2(id, text, 40),
          L"无法创建唯一的安装暂存目录。");
  stage.path = parent + (parent.back() == L'\\' ? L"" : L"\\") + stem + text;
  require(CreateDirectoryW(stage.path.c_str(), &attributes), L"无法创建私有安装暂存目录。");
  stage.owned = true;
}

void writeFile(const std::wstring& path, Bytes bytes, SetupProgress* progress = nullptr) {
  const Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                               FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(static_cast<bool>(file), L"无法写入安装暂存文件。");
  DWORD offset = 0;
  ULONGLONG previous = 0;
  if (bytes.size) reportBytes(progress, previous, 0, bytes.size);
  while (offset < bytes.size) {
    const DWORD amount = (std::min)(bytes.size - offset, DWORD{1024 * 1024});
    DWORD count = 0;
    require(WriteFile(file.value, bytes.data + offset, amount, &count, nullptr) && count == amount,
            L"无法写入完整安装暂存文件，请检查磁盘空间。");
    offset += count;
    if (offset < bytes.size) reportBytes(progress, previous, offset, bytes.size);
  }
  require(FlushFileBuffers(file.value), L"无法保存安装暂存文件。");
  if (bytes.size) reportBytes(progress, previous, offset, bytes.size);
}

Handle pin(const std::wstring& path) {
  return Handle(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
}

void stageAddon(const std::wstring& stage) {
  const auto addon = resource(106);
  require(addon.size == addonSize && matchesHash(addon, addonHash),
          L"安装程序的原生组件校验失败。");
  writeFile(stage + L"\\runtime-native.node", addon);
}

void verifyStagedFile(const std::wstring& path, HANDLE file, const wchar_t* hash,
                      size_t expected) {
  verifyPhysicalPath(path, file, false);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(file, &info) && info.nNumberOfLinks == 1 &&
          !info.nFileSizeHigh && info.nFileSizeLow == expected,
          L"安装文件身份无效。");
  std::vector<unsigned char> bytes(info.nFileSizeLow);
  DWORD offset = 0;
  while (offset < bytes.size()) {
    const DWORD amount = (std::min)(static_cast<DWORD>(bytes.size()) - offset, DWORD{1024 * 1024});
    DWORD count = 0;
    require(ReadFile(file, bytes.data() + offset, amount, &count, nullptr) && count == amount,
            L"无法读取完整的安装文件。");
    offset += count;
  }
  require(matchesHash({bytes.data(), static_cast<DWORD>(bytes.size())}, hash), L"安装文件校验失败。");
}

Handle pinDirectory(const std::wstring& path) {
  return Handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
}

std::wstring quote(const std::wstring& text) {
  require(!text.empty() && text.back() != L'\\' && text.find(L'"') == text.npos, L"安装路径无效。");
  return L"\"" + text + L"\"";
}

std::vector<wchar_t> installEnvironment(const std::wstring& stage) {
  wchar_t windows[MAX_PATH]{};
  const UINT count = GetWindowsDirectoryW(windows, MAX_PATH);
  require(count >= 3 && count < MAX_PATH, L"无法定位 Windows 系统目录。");
  const std::wstring system(windows);
  const std::wstring entries[] = {
    L"APPDATA=" + stage, L"HOME=" + stage, L"LOCALAPPDATA=" + stage,
    L"PATH=" + system + L"\\System32;" + system,
    L"SystemDrive=" + system.substr(0, 2), L"SystemRoot=" + system,
    L"TEMP=" + stage, L"TMP=" + stage, L"USERPROFILE=" + stage, L"WINDIR=" + system,
    L"XDG_CONFIG_HOME=" + stage,
  };
  std::vector<wchar_t> block;
  for (const auto& entry : entries) {
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

struct ScriptStep {
  std::string_view id;
  const wchar_t* title;
  SetupCount unit = SetupCount::checkedFiles;
  SetupProgressRange range{};
};
// Only measured work advances within a range. The result page replaces the bar
// after the final integration and cleanup work returns.
constexpr ScriptStep scriptSteps[] = {
  {"location", L"正在检查安装目录", SetupCount::checkedFiles, {25, 25}},
  {"decode", L"正在解压安装包", SetupCount::checkedFiles, {30, 30}},
  {"archive", L"正在校验包内文件", SetupCount::checkedFiles, {35, 55}},
  {"write", L"正在写入并验证应用文件", SetupCount::writtenFiles, {55, 83}},
  {"publish", L"正在启用已安装的版本", SetupCount::checkedFiles, {83, 83}},
  {"verify", L"正在检查已安装的文件"},
  {"wait", L"正在等待应用文件解除占用"},
  {"replace", L"正在移除旧版应用文件", SetupCount::removedEntries, {83, 90}},
  {"remove", L"正在移除应用文件", SetupCount::removedEntries, {20, 90}},
};

struct ScriptOutput {
  std::string pending;
  std::wstring last;
  const ScriptStep* phase = nullptr;
  const ScriptStep* displayed = nullptr;
  uint64_t completed = 0;
  uint64_t total = 0;
  bool measured = false;
  bool changed = false;
  bool overflow = false;

  void accept(std::string_view line) {
    constexpr std::string_view stage = "KITE_SETUP_PHASE ";
    constexpr std::string_view count = "KITE_SETUP_PROGRESS ";
    if (line.substr(0, stage.size()) == stage) {
      const auto name = line.substr(stage.size());
      for (const auto& step : scriptSteps) if (name == step.id && phase != &step) {
        phase = &step;
        displayed = nullptr;
        measured = false;
        changed = true;
        break;
      }
    } else if (phase && line.substr(0, count.size()) == count) {
      const auto fields = line.substr(count.size());
      const auto nameEnd = fields.find(' ');
      if (nameEnd == fields.npos || fields.substr(0, nameEnd) != phase->id) return;
      const char* start = fields.data() + nameEnd + 1;
      const char* end = fields.data() + fields.size();
      uint64_t next = 0, size = 0;
      const auto first = std::from_chars(start, end, next);
      if (first.ec != std::errc{} || first.ptr == end || *first.ptr != ' ') return;
      const auto second = std::from_chars(first.ptr + 1, end, size);
      if (second.ec != std::errc{} || second.ptr != end || size > UINT32_MAX || next > UINT32_MAX ||
          (phase->id == "verify" ? size != 0 : size == 0 || next > size) ||
          (phase->id != "verify" && phase->id != "archive" && phase->id != "write" &&
           phase->id != "replace" && phase->id != "remove") ||
          (measured && (next < completed || total != size))) return;
      completed = next;
      total = size;
      measured = changed = true;
    }
  }

  void read(HANDLE file, SetupProgress& progress, bool final = false) {
    char buffer[4096]{};
    DWORD count = 0;
    for (unsigned reads = 0; final || reads < 16; ++reads) {
      if (!ReadFile(file, buffer, sizeof(buffer), &count, nullptr)) {
        if (final && GetLastError() != ERROR_HANDLE_EOF) last.clear();
        break;
      }
      if (!count) break;
      for (DWORD index = 0; index < count; ++index) {
        const char character = buffer[index];
        if (character == '\n') {
          if (overflow) last.clear();
          else if (!pending.empty()) {
            if (pending.back() == '\r') pending.pop_back();
            if (!pending.empty()) {
              accept(pending);
              // All protocol tokens and receipts are ASCII. Raw diagnostics are never displayed.
              last.assign(pending.begin(), pending.end());
            }
          }
          pending.clear();
          overflow = false;
        } else if (!overflow) {
          if (pending.size() == sizeof(buffer)) overflow = true;
          else pending.push_back(character);
        }
      }
    }
    if (changed && phase) {
      if (phase != displayed) {
        if (phase->id == "remove") progress.step(2, L"移除应用");
        progress.stage(phase->title, phase->range);
        displayed = phase;
      }
      if (measured) progress.count(completed, total, phase->unit);
      changed = false;
    }
    progress.pump();
  }
};

struct LocationUnavailable {
  std::wstring detail;
};

struct ScriptResult {
  DWORD code;
  std::wstring output;
};

ScriptResult runScript(const std::wstring& stage, const std::wstring& parameters,
                       const wchar_t* scriptDigest, size_t scriptSize, SetupProgress& progress) {
  const auto node = stage + L"\\node.exe";
  const auto script = stage + L"\\install.mjs";
  const auto addon = stage + L"\\runtime-native.node";
  const auto runtimePin = pin(node);
  const auto scriptPin = pin(script);
  const auto addonPin = pin(addon);
  require(runtimePin && scriptPin && addonPin, L"无法锁定已验证的安装文件。");
  verifyStagedFile(node, runtimePin.value, runtimeHash, runtimeSize);
  verifyStagedFile(script, scriptPin.value, scriptDigest, scriptSize);
  verifyStagedFile(addon, addonPin.value, addonHash, addonSize);
  const std::wstring command = quote(node) + L" --no-global-search-paths " + quote(script) + L" " + parameters;
  std::vector<wchar_t> arguments(command.begin(), command.end());
  arguments.push_back(L'\0');
  auto env = installEnvironment(stage);
  SECURITY_ATTRIBUTES inherited{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  const auto logPath = stage + L"\\install.log";
  const Handle log(CreateFileW(logPath.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ, &inherited, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  const Handle nullIn(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inherited, OPEN_EXISTING, 0, nullptr));
  const Handle observer(log ? CreateFileW(logPath.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) : nullptr);
  require(log && nullIn && observer, L"无法建立安装进程的输出。");

  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
  require(bytes > 0, L"无法初始化安装进程。");
  std::vector<unsigned char> attributeBytes(bytes);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBytes.data());
  require(InitializeProcThreadAttributeList(attributes, 2, 0, &bytes), L"无法初始化安装进程。");
  const std::unique_ptr<_PROC_THREAD_ATTRIBUTE_LIST, decltype(&DeleteProcThreadAttributeList)>
    attributeGuard(attributes, DeleteProcThreadAttributeList);
  HANDLE handles[] = {log.value, nullIn.value};
  DWORD64 mitigation = PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_PREFER_SYSTEM32_ALWAYS_ON |
      PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_REMOTE_ALWAYS_ON;
  require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
              sizeof(handles), nullptr, nullptr) &&
          UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, &mitigation,
              sizeof(mitigation), nullptr, nullptr), L"无法限制安装进程。");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullIn.value;
  startup.StartupInfo.hStdOutput = log.value;
  startup.StartupInfo.hStdError = log.value;
  startup.lpAttributeList = attributes;

  const Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(job && SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
          sizeof(limits)), L"无法建立安装进程的回收范围。");
  PROCESS_INFORMATION child{};
  require(CreateProcessW(node.c_str(), arguments.data(), nullptr, nullptr, TRUE,
          CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
          env.data(), stage.c_str(), &startup.StartupInfo, &child), L"无法启动包内安装程序。");
  const Handle process(child.hProcess);
  const Handle thread(child.hThread);
  if (!AssignProcessToJobObject(job.value, process.value) || ResumeThread(thread.value) == DWORD(-1)) {
    TerminateProcess(process.value, 1);
    WaitForSingleObject(process.value, INFINITE);
    throw std::wstring(L"无法在受控范围内启动安装进程。");
  }
  ScriptOutput output;
  DWORD state = WaitForSingleObject(process.value, progress.visible() ? 125 : INFINITE);
  while (state == WAIT_TIMEOUT) {
    output.read(observer.value, progress);
    state = WaitForSingleObject(process.value, 125);
  }
  DWORD exit = 1;
  require(state == WAIT_OBJECT_0 && GetExitCodeProcess(process.value, &exit),
          L"安装进程结果未知，请检查安装目录。");
  output.read(observer.value, progress, true);
  if (output.overflow || !output.pending.empty()) output.last.clear();
  return {exit, output.last};
}

struct Installed {
  std::wstring prefix;
  bool cleaned;
};

std::wstring lastScriptLine(const std::wstring& output) {
  const auto last = output.find_last_not_of(L"\r\n");
  if (last == output.npos) return L"";
  const auto separator = output.find_last_of(L'\n', last);
  const auto first = separator == output.npos ? 0 : separator + 1;
  return output.substr(first, last - first + 1);
}

std::wstring scriptFailureCode(const std::wstring& output) {
  const auto line = lastScriptLine(output);
  const std::wstring prefix = L"KITE_SETUP_FAILURE ";
  if (line.compare(0, prefix.size(), prefix) != 0) return L"operation_failed";
  const auto code = line.substr(prefix.size());
  if (code.empty() || code.size() > 81 || code[0] < L'a' || code[0] > L'z' ||
      !std::all_of(code.begin(), code.end(), [](wchar_t value) {
        return (value >= L'a' && value <= L'z') || (value >= L'0' && value <= L'9') || value == L'_';
      })) return L"operation_failed";
  return code;
}

bool setupFilesInUse(const std::wstring& code) {
  return code == L"native_windows_candidate_in_use" || code == L"windows_installation_files_in_use";
}

std::wstring filesInUseHint(const std::wstring& code) {
  if (code == L"native_windows_candidate_in_use")
    return L"请在任务栏通知区域右键单击 Kite 图标，选择「退出」，然后重试。";
  return L"请退出 Kite，并关闭正在访问安装目录的程序，然后重试。";
}

Installed install(const std::wstring& location, SetupProgress& progress,
                  const std::wstring& previousPrefix) {
  const auto parent = temporaryDirectory();
  const auto parentPin = pinDirectory(parent);
  require(static_cast<bool>(parentPin), L"无法访问当前用户的安装暂存位置。");
  verifyPhysicalPath(parent, parentPin.value, true);
  progress.stage(L"正在验证安装包");
  progress.pump();
  const auto archive = resource(101);
  const auto script = resource(102);
  require(matchesHash(archive, archiveHash) && matchesHash(script, scriptHash), L"安装文件校验失败。");

  Stage stage;
  createStage(stage, parent);
  auto stagePin = pinDirectory(stage.path);
  require(static_cast<bool>(stagePin), L"无法锁定安装暂存目录。");
  verifyPhysicalPath(stage.path, stagePin.value, true);
  progress.stage(L"正在准备安装文件", {5, 15});
  progress.pump();
  {
    const auto runtime = readRuntime(archive, progress);
    writeFile(stage.path + L"\\node.exe", {runtime.data(), static_cast<DWORD>(runtime.size())});
  }
  const auto archivePath = stage.path + L"\\bundle.tar.zst";
  progress.stage(L"正在暂存安装文件", {15, 25});
  writeFile(archivePath, archive, &progress);
  writeFile(stage.path + L"\\install.mjs", script);
  stageAddon(stage.path);
  progress.step(2, L"安装应用");
  progress.stage(L"正在检查安装目录", {25, 25});
  progress.pump();
  ScriptResult result;
  {
    const auto archivePin = pin(archivePath);
    require(static_cast<bool>(archivePin), L"无法锁定已验证的安装包。");
    const auto parameters = quote(archivePath) + L" " + archiveHash + L" " + quote(location) +
      (previousPrefix.empty() ? L"" : L" " + quote(previousPrefix));
    result = runScript(stage.path, parameters, scriptHash, script.size, progress);
  }
  if (result.code == 3) throw LocationUnavailable{L"错误代码：" + scriptFailureCode(result.output)};
  const std::wstring receipt = L"KITE_DESKTOP_SETUP_OK " + std::wstring(expectedCandidate);
  const auto line = lastScriptLine(result.output);
  std::wstring prefix;
  if (line == receipt + L" desktop") prefix = location + L"\\resources\\app";
  else if (line == receipt + L" desktop-update") prefix = location + L"\\resources\\app-update";
  if (result.code != 0 || prefix.empty()) {
    const auto code = scriptFailureCode(result.output);
    if (setupFilesInUse(code))
      throw std::wstring(L"安装未完成。应用文件仍在使用。\n\n") + filesInUseHint(code);
    throw std::wstring(L"安装未完成。\n\n错误代码：") + code;
  }
  progress.stage(L"正在清理临时安装文件", {90, 90});
  progress.pump();
  stagePin.close();
  return {prefix, stage.clean()};
}

struct IntegrationLock {
  Handle mutex{CreateMutexW(nullptr, FALSE, integrationMutex())};
  IntegrationLock() {
    const DWORD state = mutex ? WaitForSingleObject(mutex.value, 0) : WAIT_FAILED;
    require(state == WAIT_OBJECT_0 || state == WAIT_ABANDONED,
            L"Kite 的安装或卸载正在进行。");
  }
  ~IntegrationLock() { ReleaseMutex(mutex.value); }
};

bool startHidden(const std::wstring& executable, const std::wstring& args, const std::wstring& cwd) {
  SECURITY_ATTRIBUTES inherited{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  const Handle nullFile(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, &inherited, OPEN_EXISTING, 0, nullptr));
  if (!nullFile) return false;
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  if (!size) return false;
  std::vector<unsigned char> storage(size);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size)) return false;
  const std::unique_ptr<_PROC_THREAD_ATTRIBUTE_LIST, decltype(&DeleteProcThreadAttributeList)>
    guard(attributes, DeleteProcThreadAttributeList);
  HANDLE stream = nullFile.value;
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &stream,
                                  sizeof(stream), nullptr, nullptr)) return false;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stream;
  startup.StartupInfo.hStdOutput = stream;
  startup.StartupInfo.hStdError = stream;
  startup.lpAttributeList = attributes;
  std::wstring command = quote(executable);
  if (!args.empty()) command += L" " + args;
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr,
      cwd.empty() ? nullptr : cwd.c_str(), &startup.StartupInfo, &child)) return false;
  CloseHandle(child.hThread);
  CloseHandle(child.hProcess);
  return true;
}

bool openDesktop(const std::wstring& prefix) {
  const auto launcher = prefix + L"\\bin\\kite-desktop.exe";
  const auto file = pin(launcher);
  if (!file) return false;
  verifyPhysicalPath(launcher, file.value, false);
  return startHidden(launcher, L"", prefix);
}

std::wstring executablePath() {
  std::vector<wchar_t> path(32768);
  const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  require(size && size < path.size(), L"无法识别 Kite 安装程序。");
  return std::wstring(path.data(), size);
}

bool deleteSupportHost(const std::wstring& path, const std::wstring& prefix) {
  if (!isSupportHost(path, prefix)) return false;
  if (!DeleteFileW(path.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) return false;
  if (isRootDesktopHost(path, prefix)) return true;
  return RemoveDirectoryW(path.substr(0, path.find_last_of(L'\\')).c_str()) ||
    GetLastError() == ERROR_PATH_NOT_FOUND;
}

bool retireRunningHost(const std::wstring& path, const std::wstring& prefix) {
  if (!isSupportHost(path, prefix)) return false;
  wchar_t system[MAX_PATH]{};
  const UINT size = GetSystemDirectoryW(system, MAX_PATH);
  if (!size || size >= MAX_PATH) return false;
  const std::wstring executable = std::wstring(system) + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  FILETIME birth{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &birth, &exit, &kernel, &user)) return false;
  const auto creation = (static_cast<ULONGLONG>(birth.dwHighDateTime) << 32) | birth.dwLowDateTime;
  const std::wstring arguments = L"-NoProfile -NonInteractive -Command \""
    L"$p=Get-Process -Id " + std::to_wstring(GetCurrentProcessId()) +
    L" -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToFileTimeUtc() -eq " +
    std::to_wstring(creation) + L"){$p.WaitForExit()};"
    L"$f=$env:KITE_SETUP_RETIRED_HOST; [IO.File]::Delete($f);"
    L"[IO.Directory]::Delete([IO.Path]::GetDirectoryName($f))\"";
  const bool rootHost = isRootDesktopHost(path, prefix);
  const auto originalParent = path.substr(0, path.find_last_of(L'\\'));
  const auto parent = rootHost ? originalParent : supportParent(prefix);
  try {
    const auto parentPin = pinDirectory(parent);
    if (!parentPin) return false;
    verifyPhysicalPath(parent, parentPin.value, true);
    Stage stage;
    createStage(stage, parent, L".kite-desktop-retired-");
    const auto directory = pinDirectory(stage.path);
    if (!directory || !SetFileAttributesW(stage.path.c_str(), FILE_ATTRIBUTE_HIDDEN)) return false;
    verifyPhysicalPath(stage.path, directory.value, true);
    const auto moved = stage.path + L"\\Kite Desktop.exe";
    // Detach this exact host while the integration lock is held. A subsequent
    // installer can reuse the original name without racing delayed cleanup.
    if (!MoveFileExW(path.c_str(), moved.c_str(), MOVEFILE_WRITE_THROUGH)) return false;
    stage.owned = false;
    const bool environment = SetEnvironmentVariableW(L"KITE_SETUP_RETIRED_HOST", moved.c_str());
    const bool started = environment && startHidden(executable, arguments, L"");
    if (environment) SetEnvironmentVariableW(L"KITE_SETUP_RETIRED_HOST", nullptr);
    if (!started) {
      stage.owned = MoveFileExW(moved.c_str(), path.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE;
      return false;
    }
    return rootHost || RemoveDirectoryW(originalParent.c_str()) || GetLastError() == ERROR_PATH_NOT_FOUND;
  } catch (const std::wstring&) {
    return false;
  }
}

bool sameFile(const std::wstring& path, Bytes expected) {
  const auto file = pin(path);
  if (!file) return false;
  verifyPhysicalPath(path, file.value, false);
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size) || size.QuadPart != expected.size) return false;
  std::vector<unsigned char> actual(expected.size);
  DWORD count = 0;
  return ReadFile(file.value, actual.data(), expected.size, &count, nullptr) &&
    count == expected.size && std::equal(actual.begin(), actual.end(), expected.data);
}

bool rootDesktopHostAvailable(const std::wstring& host,
                              const std::optional<DesktopRegistration>& previous, Bytes payload) {
  const auto attributes = GetFileAttributesW(host.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    const auto error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }
  return !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
    ((previous && _wcsicmp(previous->host.c_str(), host.c_str()) == 0) || sameFile(host, payload));
}

DesktopRegistration publishDesktop(const SetupSelection& selection, const Installed& installed,
                                   const std::optional<DesktopRegistration>& previous) {
  const auto& parent = selection.location;
  require(!parent.empty(), L"Windows 安装记录目录无效。");
  const auto parentPin = pinDirectory(parent);
  require(static_cast<bool>(parentPin), L"无法访问 Windows 安装记录目录。");
  verifyPhysicalPath(parent, parentPin.value, true);
  Stage support;
  createStage(support, parent);
  const auto directory = pinDirectory(support.path);
  require(static_cast<bool>(directory), L"无法锁定 Windows 安装记录目录。");
  verifyPhysicalPath(support.path, directory.value, true);
  const auto stagedHost = support.path + L"\\Kite Desktop.exe";
  const auto payload = resource(104);
  require(payload.size > 2 && payload.data[0] == 'M' && payload.data[1] == 'Z',
          L"安装包中的桌面入口无效。");
  writeFile(stagedHost, payload);
  const auto host = selection.location + L"\\Kite Desktop.exe";
  const bool present = GetFileAttributesW(host.c_str()) != INVALID_FILE_ATTRIBUTES;
  require(rootDesktopHostAvailable(host, previous, payload),
          L"安装目录已有同名文件，请保留原文件并选择 Kite 的安装目录。");
  require(MoveFileExW(stagedHost.c_str(), host.c_str(), MOVEFILE_WRITE_THROUGH |
            (present ? MOVEFILE_REPLACE_EXISTING : 0)), L"无法发布桌面启动程序，请退出 Kite 后重试。");
  DesktopRegistration record{selection.location, installed.prefix, host, selection.desktopShortcut};
  // The receipt can be retried with the same managed prefix if Windows registration is interrupted.
  require(registerDesktop(record, productVersion),
          L"桌面文件已安装。Windows 应用登记未完成，请重新运行安装器。");
  const auto saved = readDesktopRegistration();
  require(saved && saved->host == host && saved->prefix == installed.prefix,
          L"桌面文件已安装。Windows 应用登记未确认，请重新运行安装器。");
  return record;
}

std::vector<unsigned char> installedRuntime(const std::wstring& prefix, SetupProgress& progress) {
  const auto path = prefix + L"\\releases\\" + expectedCandidate + L"\\terminal\\runtime\\node.exe";
  const auto file = pin(path);
  require(static_cast<bool>(file), L"找不到此安装对应的卸载运行时。");
  verifyPhysicalPath(path, file.value, false);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(file.value, &info) && info.nNumberOfLinks == 1 &&
          !info.nFileSizeHigh && info.nFileSizeLow == runtimeSize, L"卸载运行时身份无效。");
  std::vector<unsigned char> bytes(runtimeSize);
  DWORD offset = 0;
  ULONGLONG previous = 0;
  reportBytes(&progress, previous, 0, bytes.size());
  while (offset < bytes.size()) {
    const DWORD amount = (std::min)(static_cast<DWORD>(bytes.size()) - offset, DWORD{1024 * 1024});
    DWORD count = 0;
    require(ReadFile(file.value, bytes.data() + offset, amount, &count, nullptr) && count == amount,
            L"无法读取完整的卸载运行时。");
    offset += count;
    reportBytes(&progress, previous, offset, bytes.size());
  }
  require(matchesHash({bytes.data(), static_cast<DWORD>(bytes.size())}, runtimeHash),
          L"卸载运行时校验失败。");
  return bytes;
}

struct UninstallFilesInUse { std::wstring code; };

void uninstallFiles(const std::wstring& prefix, SetupProgress& progress) {
  const DWORD attributes = GetFileAttributesW(prefix.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES &&
      (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND)) return;
  const auto parent = temporaryDirectory();
  const auto parentPin = pinDirectory(parent);
  require(static_cast<bool>(parentPin), L"无法访问当前用户的卸载暂存目录。");
  verifyPhysicalPath(parent, parentPin.value, true);
  Stage stage;
  createStage(stage, parent);
  auto directory = pinDirectory(stage.path);
  require(static_cast<bool>(directory), L"无法锁定卸载暂存目录。");
  verifyPhysicalPath(stage.path, directory.value, true);
  progress.stage(L"正在准备卸载文件", {0, 10});
  progress.pump();
  const auto script = resource(105);
  require(matchesHash(script, uninstallHash), L"卸载程序校验失败。");
  {
    const auto runtime = installedRuntime(prefix, progress);
    writeFile(stage.path + L"\\node.exe", {runtime.data(), static_cast<DWORD>(runtime.size())});
  }
  writeFile(stage.path + L"\\install.mjs", script);
  stageAddon(stage.path);
  progress.stage(L"正在检查已安装的文件", {10, 10});
  progress.pump();
  const auto result = runScript(stage.path, quote(prefix), uninstallHash, script.size, progress);
  if (result.code || lastScriptLine(result.output) != L"KITE_DESKTOP_UNINSTALL_OK") {
    const auto code = scriptFailureCode(result.output);
    if (setupFilesInUse(code)) throw UninstallFilesInUse{code};
    throw std::wstring(L"卸载未完成。\n\n错误代码：") + code;
  }
  progress.stage(L"正在清理临时卸载文件", {90, 90});
  progress.pump();
  directory.close();
  require(stage.clean(), L"应用文件已移除。暂存文件清理未完成，请重新运行卸载。");
}

int runMaintenance(bool uninstall, bool quiet, bool fixtureRun) {
  const auto self = executablePath();
  const auto current = [&] {
    const auto record = readDesktopRegistration();
    require(record && _wcsicmp(record->host.c_str(), self.c_str()) == 0,
            L"找不到此 Kite 安装对应的 Windows 记录。");
    return *record;
  };
  if (!uninstall) {
    require(openDesktop(current().prefix), L"无法打开 Kite 桌面版。");
    return 0;
  }
  const IntegrationLock lock;
  const auto record = current();
  SetupProgress progress(!quiet, L"卸载 Kite 桌面版", L"卸载范围：当前 Windows 用户");
  if (!quiet && !fixtureRun && !progress.choose(L"卸载 Kite 桌面版",
                                                 L"卸载程序将移除 Kite 桌面版及其快捷方式。会话、设置和工作区文件将保留。\n\n单击「卸载」继续。",
                                                 L"卸载", L"取消"))
    return ERROR_CANCELLED;
  for (;;) {
    try {
      progress.step(1, L"检查应用");
      uninstallFiles(record.prefix, progress);
      break;
    } catch (const UninstallFilesInUse& error) {
      const auto message = filesInUseHint(error.code);
      if (quiet) throw message;
      if (!progress.choose(L"应用文件仍在使用", message.c_str(), L"重试", L"取消"))
        return ERROR_CANCELLED;
    }
  }
  progress.step(3, L"完成卸载");
  progress.stage(L"正在移除快捷方式和已安装应用条目", {95, 95});
  progress.pump();
  const bool shortcuts = removeDesktopShortcuts(record);
  require(unregisterDesktop(record), L"应用文件已移除。Windows 应用登记清理未完成。");
  progress.stage(L"正在安排清理卸载程序", {98, 98});
  progress.pump();
  require(retireRunningHost(self, record.prefix), L"应用已卸载。启动文件清理未完成。");
  if (!quiet) {
    std::wstring message = L"Kite 桌面版已卸载。会话、设置和工作区文件已保留。";
    if (!shortcuts) message += L"\n部分快捷方式未能移除。";
    message += L"\n\n单击「完成」关闭向导。";
    progress.choose(L"完成 Kite 桌面版\n卸载向导", message.c_str(), L"完成", nullptr);
  }
  return shortcuts ? 0 : 2;
}

int runSetup(std::wstring location, bool quiet, bool requestedShortcut, bool fixtureRun) {
  const IntegrationLock lock;
  const auto previous = readDesktopRegistration();
  const auto discovered = discoverDesktopLocation();
  const bool upgrade = !discovered.empty();
  if (!location.empty()) {
    location = installationLocation(std::move(location));
    if (upgrade && _wcsicmp(location.c_str(), discovered.c_str()) != 0)
      throw std::wstring(L"已安装 Kite。请在原目录更新，或先卸载后选择新目录。");
  }
  if (location.empty()) location = upgrade ? discovered : defaultDesktopLocation();
  SetupSelection selection{
    installationLocation(location),
    upgrade ? previous && previous->desktopShortcut : requestedShortcut || !quiet,
  };
  for (bool chooseLocationAgain = false;; chooseLocationAgain = true) {
    if (!quiet && !fixtureRun && !upgrade && !showInstallWizard(selection, chooseLocationAgain))
      return ERROR_CANCELLED;
    SetupProgress progress(!quiet, upgrade ? L"更新 Kite 桌面版" : L"安装 Kite 桌面版",
                           upgrade ? L"更新范围：当前 Windows 用户" : L"安装范围：当前 Windows 用户");
    if (!quiet && !fixtureRun && upgrade && !progress.choose(L"更新 Kite 桌面版",
        L"安装程序将在下方的目录中更新 Kite 桌面版。会话和设置将保留。\n\n单击「更新」继续。",
        L"更新", L"取消", selection.location.c_str()))
      return ERROR_CANCELLED;
    progress.step(1, upgrade ? L"准备更新" : L"准备安装");
    Installed installed;
    try {
      if (!rootDesktopHostAvailable(selection.location + L"\\Kite Desktop.exe",
            previous, resource(104)))
        throw LocationUnavailable{L"目录中已有同名文件或无法访问此位置。"};
      installed = install(selection.location, progress,
        previous && _wcsicmp(previous->location.c_str(), selection.location.c_str()) == 0
          ? previous->prefix : L"");
    } catch (const LocationUnavailable& error) {
      const std::wstring message = L"无法使用所选安装目录。\n\n" + error.detail + L"\n\n" +
        (upgrade ? L"请检查原安装目录的访问权限和文件占用，然后重新运行安装程序。"
                 : L"请选择当前 Windows 用户可写的本地目录。");
      if (quiet || upgrade || fixtureRun) throw message;
      MessageBoxW(progress.owner(), message.c_str(), title, MB_OK | MB_ICONWARNING);
      continue;
    }
    progress.step(3, upgrade ? L"完成更新" : L"完成安装");
    progress.stage(L"正在注册应用并配置快捷方式", {95, 95});
    progress.pump();
    const auto record = publishDesktop(selection, installed, previous);
    const bool shortcuts = applyDesktopShortcuts(record, upgrade);
    const bool previousHostCleaned = !shortcuts || !previous || previous->host == record.host ||
      deleteSupportHost(previous->host, previous->prefix);
    const bool finished = installed.cleaned && shortcuts && previousHostCleaned;
    if (!quiet) {
      std::wstring message = upgrade ? L"Kite 桌面版已更新。" : L"Kite 桌面版已安装到此计算机。";
      if (!shortcuts) message += L"\n快捷方式设置未完成。可从安装目录运行 Kite Desktop.exe。";
      if (!installed.cleaned) message += L"\n部分临时安装文件未能清理。";
      if (!previousHostCleaned) message += L"\n旧版启动程序未能清理。";
      message += L"\n\n单击「完成」关闭向导。";
      if (progress.choose(upgrade ? L"完成 Kite 桌面版\n更新向导" : L"完成 Kite 桌面版\n安装向导",
                          message.c_str(), L"完成", nullptr, nullptr, true) &&
          !openDesktop(installed.prefix)) {
        MessageBoxW(progress.owner(), L"安装已完成。无法启动 Kite，请稍后从安装目录运行 Kite Desktop.exe。",
                    title, MB_OK | MB_ICONWARNING);
      }
    }
    return finished ? 0 : 2;
  }
}

void reportFailure(const std::wstring& message) {
  OutputDebugStringW(message.c_str());
  const auto error = GetStdHandle(STD_ERROR_HANDLE);
  if (!error || error == INVALID_HANDLE_VALUE) return;
  const int size = WideCharToMultiByte(CP_UTF8, 0, message.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return;
  std::vector<char> utf8(size);
  WideCharToMultiByte(CP_UTF8, 0, message.c_str(), -1, utf8.data(), size, nullptr, nullptr);
  utf8.back() = '\n';
  DWORD written = 0;
  WriteFile(error, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  const bool com = SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED));
  bool quiet = false;
  bool uninstall = false;
  int status = 1;
  try {
    int argc = 0;
    const std::unique_ptr<wchar_t*, decltype(&LocalFree)> argv(CommandLineToArgvW(GetCommandLineW(), &argc), LocalFree);
    require(argv != nullptr, L"无法读取安装选项。");
    std::wstring location;
    bool desktopShortcut = false;
    bool fixtureRun = false;
    for (int i = 1; i < argc; ++i) {
      if (wcscmp(argv.get()[i], L"--quiet") == 0 && !quiet) quiet = true;
      else if (wcscmp(argv.get()[i], L"--uninstall") == 0 && !uninstall) uninstall = true;
      else if (wcscmp(argv.get()[i], L"--desktop-shortcut") == 0 && !desktopShortcut) desktopShortcut = true;
#ifdef KITE_SETUP_FIXTURE
      else if (wcscmp(argv.get()[i], L"--fixture-run") == 0 && !fixtureRun) fixtureRun = true;
#endif
      else if (wcscmp(argv.get()[i], L"--prefix") == 0 && location.empty() && i + 1 < argc)
        location = argv.get()[++i];
      else throw std::wstring(L"无法识别安装选项。");
    }
    if (FindResourceW(nullptr, MAKEINTRESOURCEW(105), RT_RCDATA)) {
      require(location.empty() && !desktopShortcut && (!quiet || uninstall), L"无法识别桌面启动选项。");
      require(!fixtureRun || (!quiet && uninstall), L"验证模式需要可见的卸载窗口。");
      status = runMaintenance(uninstall, quiet, fixtureRun);
    } else {
      require(!uninstall, L"请从 Windows 的「已安装的应用」卸载 Kite。");
      require(!fixtureRun || (!quiet && !location.empty()), L"验证模式需要明确的安装目录。");
      status = runSetup(location, quiet, desktopShortcut, fixtureRun);
    }
  } catch (const std::wstring& message) {
    if (!quiet) MessageBoxW(nullptr, message.c_str(), uninstall ? L"Kite 桌面版卸载" : title,
                          MB_OK | MB_ICONERROR);
    reportFailure(message);
  } catch (...) {
    if (!quiet) MessageBoxW(nullptr, L"操作遇到意外错误。", uninstall ? L"Kite 桌面版卸载" : title,
                          MB_OK | MB_ICONERROR);
  }
  if (com) CoUninitialize();
  return status;
}
