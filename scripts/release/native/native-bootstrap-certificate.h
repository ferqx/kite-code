#pragma once
#include <windows.h>
#include <sddl.h>
#include <bcrypt.h>
#include <string>
#include <stdexcept>

// Native-only, original-child-HANDLE certificate. The endpoint name is not an authority.
class NativeBootstrapCertificate {
  HANDLE pipe_ = INVALID_HANDLE_VALUE, stop_ = nullptr, thread_ = nullptr;
  unsigned char bytes_[32]{};
  static void require(bool value) { if (!value) throw std::runtime_error("native_certificate_unknown"); }
  bool complete(OVERLAPPED& operation, BOOL immediate, DWORD& bytes, DWORD timeout) {
    if (immediate) return true;
    if (GetLastError() != ERROR_IO_PENDING) return false;
    HANDLE waits[] = {operation.hEvent, stop_};
    if (WaitForMultipleObjects(2, waits, FALSE, timeout) != WAIT_OBJECT_0) {
      // Never free an OVERLAPPED/event/pipe while the kernel still owns the operation.
      if (!CancelIoEx(pipe_, &operation) && GetLastError() != ERROR_NOT_FOUND) {
        while (WaitForSingleObject(operation.hEvent, INFINITE) != WAIT_OBJECT_0) Sleep(10);
      }
    }
    const BOOL result = GetOverlappedResult(pipe_, &operation, &bytes, TRUE);
    return result != FALSE;
  }
  static DWORD WINAPI serve(void* context) {
    auto& self = *static_cast<NativeBootstrapCertificate*>(context);
    while (WaitForSingleObject(self.stop_, 0) == WAIT_TIMEOUT) {
      OVERLAPPED operation{};
      operation.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      if (!operation.hEvent) break;
      DWORD received = 0;
      BOOL connected = ConnectNamedPipe(self.pipe_, &operation);
      if (!connected && GetLastError() == ERROR_PIPE_CONNECTED) connected = TRUE;
      bool ok = self.complete(operation, connected, received, INFINITE);
      if (ok && WaitForSingleObject(self.stop_, 0) == WAIT_TIMEOUT) {
        { const HANDLE event = operation.hEvent; operation = {}; operation.hEvent = event; ResetEvent(event); }
        ok = self.complete(operation, WriteFile(self.pipe_, self.bytes_, 32, &received, &operation), received, 5000) && received == 32;
        if (ok) {
          // The reader closes after the fixed certificate: do not disconnect ahead of its read.
          unsigned char unexpected;
          { const HANDLE event = operation.hEvent; operation = {}; operation.hEvent = event; ResetEvent(event); }
          self.complete(operation, ReadFile(self.pipe_, &unexpected, 1, &received, &operation), received, 5000);
        }
      }
      // All overlapped work has an actual kernel completion before event reuse/close.
      while (!CloseHandle(operation.hEvent)) Sleep(10);
      if (!DisconnectNamedPipe(self.pipe_) && GetLastError() != ERROR_PIPE_NOT_CONNECTED) break;
    }
    return 0;
  }
public:
  std::wstring path;
  explicit NativeBootstrapCertificate(PSID sid) {
    unsigned char random[16];
    require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
    path = L"\\\\.\\pipe\\kite-native-launch-";
    for (auto byte : random) { path += L"0123456789abcdef"[byte >> 4]; path += L"0123456789abcdef"[byte & 15]; }
    LPWSTR stringSid = nullptr;
    require(ConvertSidToStringSidW(sid, &stringSid));
    const auto descriptorText = L"D:P(A;;FA;;;" + std::wstring(stringSid) + L")";
    require(LocalFree(stringSid) == nullptr);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptorText.c_str(), SDDL_REVISION_1, &descriptor, nullptr));
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
    pipe_ = CreateNamedPipeW(path.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 32, 1, 5000, &security);
    // A cleanup uncertainty must not destroy a live first-instance endpoint.
    while (LocalFree(descriptor) != nullptr) Sleep(10);
    require(pipe_ != INVALID_HANDLE_VALUE);
    stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    require(stop_ != nullptr);
  }
  void bind(HANDLE originalChild) {
    require(thread_ == nullptr);
    FILETIME born, exit, kernel, user;
    require(GetProcessTimes(originalChild, &born, &exit, &kernel, &user));
    const DWORD pid = GetProcessId(originalChild);
    require(pid != 0 && WaitForSingleObject(originalChild, 0) == WAIT_TIMEOUT);
    const char magic[] = "KITELCH1";
    for (unsigned i = 0; i < 8; ++i) bytes_[i] = magic[i];
    for (unsigned i = 0; i < 4; ++i) bytes_[8+i] = static_cast<unsigned char>(pid >> (8*i));
    const unsigned long long birth = (static_cast<unsigned long long>(born.dwHighDateTime) << 32) | born.dwLowDateTime;
    require(birth != 0);
    for (unsigned i = 0; i < 8; ++i) bytes_[16+i] = static_cast<unsigned char>(birth >> (8*i));
    thread_ = CreateThread(nullptr, 0, serve, this, 0, nullptr);
    require(thread_ != nullptr);
  }
  void close() {
    if (stop_) { while (!SetEvent(stop_)) Sleep(10); }
    if (thread_) { while (WaitForSingleObject(thread_, INFINITE) != WAIT_OBJECT_0) Sleep(10); while (!CloseHandle(thread_)) Sleep(10); thread_ = nullptr; }
    if (pipe_ != INVALID_HANDLE_VALUE) { while (!CloseHandle(pipe_)) Sleep(10); pipe_ = INVALID_HANDLE_VALUE; }
    if (stop_) { while (!CloseHandle(stop_)) Sleep(10); stop_ = nullptr; }
  }
};
