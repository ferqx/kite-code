#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <string_view>

std::wstring installationLocation(std::wstring location);
struct SetupSelection {
  std::wstring location;
  bool desktopShortcut = true;
};
bool showInstallWizard(SetupSelection& selection, bool chooseLocationAgain);

enum class SetupCount { bytes, checkedFiles, writtenFiles, removedEntries };

struct SetupProgressRange {
  unsigned start = 0;
  unsigned end = 0;
};

class SetupProgress {
public:
  SetupProgress(bool visible, const wchar_t* heading, const wchar_t* subtitle);
  ~SetupProgress();
  SetupProgress(const SetupProgress&) = delete;
  SetupProgress& operator=(const SetupProgress&) = delete;
  bool visible() const { return window != nullptr; }
  void pump();
  void step(unsigned number, const wchar_t* label);
  void stage(const wchar_t* heading, SetupProgressRange range = {});
  void count(uint64_t completed, uint64_t total, SetupCount unit);
  void record(std::wstring_view line);
  const std::wstring& history() const { return journal; }
  bool choose(const wchar_t* heading, const wchar_t* detail, const wchar_t* primary,
              const wchar_t* secondary, const wchar_t* location = nullptr, bool offerLaunch = false,
              const wchar_t* logPath = nullptr);
  HWND owner() const { return window; }

private:
  static INT_PTR CALLBACK dispatch(HWND, UINT, WPARAM, LPARAM);
  void advance(unsigned position);
  HWND window = nullptr;
  const wchar_t* operation;
  const wchar_t* subtitle;
  const wchar_t* failureLog = nullptr;
  std::wstring journal;
  SetupProgressRange range;
  unsigned position = 0;
  int choice = 0;
  bool choosing = false;
};
