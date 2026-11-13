#pragma once

#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <tlhelp32.h>
#include <winternl.h>

#include <array>
#include <cstdint>
#include <cwchar>
#include <filesystem>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace kite {
using WindowsCall = uint64_t (*)(void*, const uint64_t*);

template <typename T> T windowsArgument(uint64_t value) {
  if constexpr (std::is_lvalue_reference_v<T>) {
    return *reinterpret_cast<std::add_pointer_t<std::remove_reference_t<T>>>(value);
  } else if constexpr (std::is_pointer_v<T>) {
    return reinterpret_cast<T>(value);
  } else if constexpr (std::is_same_v<T, LARGE_INTEGER>) {
    LARGE_INTEGER integer{};
    integer.QuadPart = static_cast<LONGLONG>(value);
    return integer;
  } else {
    return static_cast<T>(value);
  }
}

template <typename Function> struct WindowsFunction;
template <typename Result, typename... Args>
struct WindowsFunction<Result (WINAPI *)(Args...)> {
  template <size_t... Index>
  static uint64_t invoke(void* address, const uint64_t* values, std::index_sequence<Index...>) {
    auto call = reinterpret_cast<Result (WINAPI *)(Args...)>(address);
    if constexpr (std::is_void_v<Result>) {
      call(windowsArgument<Args>(values[Index])...);
      return 0;
    } else if constexpr (std::is_pointer_v<Result>) {
      return reinterpret_cast<uintptr_t>(call(windowsArgument<Args>(values[Index])...));
    } else {
      return static_cast<uint64_t>(call(windowsArgument<Args>(values[Index])...));
    }
  }
  static uint64_t call(void* address, const uint64_t* values) {
    return invoke(address, values, std::index_sequence_for<Args...>{});
  }
};

// These two NT entrypoints are loaded dynamically, independent of SDK import libraries.
using NtCreateFileSignature = NTSTATUS (NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileSignature = NTSTATUS (NTAPI *)(HANDLE, PIO_STATUS_BLOCK,
    PVOID, ULONG, FILE_INFORMATION_CLASS);

inline std::string windowsSystemLibrary(const std::string& input) {
  constexpr const wchar_t* supported[] = {
    L"kernel32.dll", L"ntdll.dll", L"advapi32.dll", L"shell32.dll", L"ole32.dll"
  };
  if (input.find('\0') != std::string::npos)
    throw std::runtime_error("native_runtime_library_unsupported");
  const auto path = std::filesystem::u8path(input);
  const auto name = path.filename().native();
  std::array<wchar_t, MAX_PATH + 1> buffer{};
  const auto length = GetSystemDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
  if (!length || length >= buffer.size())
    throw std::runtime_error("native_runtime_library_unavailable");
  for (const auto* library : supported) {
    if (_wcsicmp(name.c_str(), library) != 0) continue;
    const auto system = (std::filesystem::path(buffer.data()) / library).native();
    if (path.has_parent_path() && _wcsicmp(path.c_str(), system.c_str()) != 0) break;
    const std::wstring_view basename(library);
    return std::string(basename.begin(), basename.end());
  }
  throw std::runtime_error("native_runtime_library_unsupported");
}

inline WindowsCall windowsCall(const std::string& library, const std::string& name,
                               const std::string& signature) {
#define WIN32_ENTRY(symbol, abi) \
  if (name == #symbol && signature == abi) return WindowsFunction<decltype(&::symbol)>::call;
  if (library == "advapi32.dll") {
    WIN32_ENTRY(ConvertSidToStringSidA, "ptr,ptr:bool")
    WIN32_ENTRY(ConvertSidToStringSidW, "ptr,ptr:bool")
    WIN32_ENTRY(ConvertStringSecurityDescriptorToSecurityDescriptorW, "ptr,u32,ptr,ptr:bool")
    WIN32_ENTRY(EqualSid, "ptr,ptr:bool")
    WIN32_ENTRY(GetAce, "ptr,u32,ptr:bool")
    WIN32_ENTRY(GetLengthSid, "ptr:u32")
    WIN32_ENTRY(GetSecurityDescriptorControl, "ptr,ptr,ptr:bool")
    WIN32_ENTRY(GetSecurityInfo, "u64,u32,u32,ptr,ptr,ptr,ptr,ptr:u32")
    WIN32_ENTRY(GetTokenInformation, "u64,u32,ptr,u32,ptr:bool")
    WIN32_ENTRY(IsValidSid, "ptr:bool")
    WIN32_ENTRY(IsWellKnownSid, "ptr,u32:bool")
    WIN32_ENTRY(OpenProcessToken, "u64,u32,ptr:bool")
    WIN32_ENTRY(SetSecurityInfo, "u64,u32,u32,ptr,ptr,ptr,ptr:u32")
  }
  if (library == "kernel32.dll") {
    WIN32_ENTRY(AssignProcessToJobObject, "u64,u64:bool")
    WIN32_ENTRY(CancelIoEx, "u64,ptr:bool")
    WIN32_ENTRY(CloseHandle, "u64:bool")
    WIN32_ENTRY(ConnectNamedPipe, "u64,ptr:bool")
    WIN32_ENTRY(CreateDirectoryW, "ptr,ptr:bool")
    WIN32_ENTRY(CreateEventW, "ptr,bool,bool,ptr:u64")
    WIN32_ENTRY(CreateFileW, "ptr,u32,u32,ptr,u32,u32,u64:u64")
    WIN32_ENTRY(CreateJobObjectW, "ptr,ptr:u64")
    WIN32_ENTRY(CreateNamedPipeW, "ptr,u32,u32,u32,u32,u32,u32,ptr:u64")
    WIN32_ENTRY(CreatePipe, "ptr,ptr,ptr,u32:bool")
    WIN32_ENTRY(CreateProcessW, "ptr,ptr,ptr,ptr,bool,u32,ptr,ptr,ptr,ptr:bool")
    WIN32_ENTRY(CreateToolhelp32Snapshot, "u32,u32:u64")
    WIN32_ENTRY(DeleteProcThreadAttributeList, "ptr:void")
    WIN32_ENTRY(DisconnectNamedPipe, "u64:bool")
    WIN32_ENTRY(FlushFileBuffers, "u64:bool")
    WIN32_ENTRY(GetCurrentProcess, ":u64")
    WIN32_ENTRY(GetCurrentProcessId, ":u32")
    WIN32_ENTRY(GetExitCodeProcess, "u64,ptr:bool")
    WIN32_ENTRY(GetFileAttributesW, "ptr:u32")
    WIN32_ENTRY(GetFileInformationByHandle, "u64,ptr:bool")
    WIN32_ENTRY(GetFileInformationByHandleEx, "u64,u32,ptr,u32:bool")
    WIN32_ENTRY(GetFileType, "u64:u32")
    WIN32_ENTRY(GetFinalPathNameByHandleW, "u64,ptr,u32,u32:u32")
    WIN32_ENTRY(GetLastError, ":u32")
    WIN32_ENTRY(GetNamedPipeClientProcessId, "u64,ptr:bool")
    WIN32_ENTRY(GetNamedPipeServerProcessId, "u64,ptr:bool")
    WIN32_ENTRY(GetOverlappedResult, "u64,ptr,ptr,bool:bool")
    WIN32_ENTRY(GetProcessId, "u64:u32")
    WIN32_ENTRY(GetProcessTimes, "u64,ptr,ptr,ptr,ptr:bool")
    WIN32_ENTRY(GetSystemDirectoryW, "ptr,u32:u32")
    WIN32_ENTRY(InitializeProcThreadAttributeList, "ptr,u32,u32,ptr:bool")
    WIN32_ENTRY(IsProcessInJob, "u64,u64,ptr:bool")
    WIN32_ENTRY(LocalFree, "ptr:ptr")
    WIN32_ENTRY(LocalFree, "u64:u64")
    WIN32_ENTRY(LockFileEx, "u64,u32,u32,u32,u32,ptr:bool")
    WIN32_ENTRY(MoveFileExW, "ptr,ptr,u32:bool")
    WIN32_ENTRY(OpenProcess, "u32,bool,u32:u64")
    WIN32_ENTRY(PeekNamedPipe, "u64,ptr,u32,ptr,ptr,ptr:bool")
    WIN32_ENTRY(Process32FirstW, "u64,ptr:bool")
    WIN32_ENTRY(Process32NextW, "u64,ptr:bool")
    WIN32_ENTRY(QueryFullProcessImageNameW, "u64,u32,ptr,ptr:bool")
    WIN32_ENTRY(QueryInformationJobObject, "u64,u32,ptr,u32,ptr:bool")
    WIN32_ENTRY(ReadFile, "u64,ptr,u32,ptr,ptr:bool")
    WIN32_ENTRY(ResumeThread, "u64:u32")
    WIN32_ENTRY(SetEndOfFile, "u64:bool")
    WIN32_ENTRY(SetFileAttributesW, "ptr,u32:bool")
    WIN32_ENTRY(SetFileInformationByHandle, "u64,u32,ptr,u32:bool")
    WIN32_ENTRY(SetFilePointerEx, "u64,i64,ptr,u32:bool")
    WIN32_ENTRY(SetHandleInformation, "u64,u32,u32:bool")
    WIN32_ENTRY(SetInformationJobObject, "u64,u32,ptr,u32:bool")
    WIN32_ENTRY(TerminateJobObject, "u64,u32:bool")
    WIN32_ENTRY(TerminateProcess, "u64,u32:bool")
    WIN32_ENTRY(UnlockFileEx, "u64,u32,u32,u32,ptr:bool")
    WIN32_ENTRY(UpdateProcThreadAttribute, "ptr,u32,u64,ptr,u64,ptr,ptr:bool")
    WIN32_ENTRY(WaitForSingleObject, "u64,u32:u32")
    WIN32_ENTRY(WaitNamedPipeW, "ptr,u32:bool")
    WIN32_ENTRY(WriteFile, "u64,ptr,u32,ptr,ptr:bool")
  }
  if (library == "ntdll.dll") {
    if (name == "NtCreateFile" && signature == "ptr,u32,ptr,ptr,ptr,u32,u32,u32,u32,ptr,u32:i32")
      return WindowsFunction<NtCreateFileSignature>::call;
    if (name == "NtSetInformationFile" && signature == "u64,ptr,ptr,u32,u32:i32")
      return WindowsFunction<NtSetInformationFileSignature>::call;
  }
  if (library == "ole32.dll") {
    WIN32_ENTRY(CoTaskMemFree, "ptr:void")
  }
  if (library == "shell32.dll") {
    WIN32_ENTRY(SHGetKnownFolderPath, "ptr,u32,u64,ptr:i32")
  }
#undef WIN32_ENTRY
  throw std::runtime_error("native_runtime_signature_unsupported:" + name);
}
}
