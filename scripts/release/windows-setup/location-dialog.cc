#include <windows.h>
#include <shlobj.h>

#include <algorithm>
#include <memory>
#include <string>

#include "location-dialog.h"
#include "resource.h"

namespace {

#ifdef KITE_SETUP_FIXTURE
constexpr wchar_t appFolder[] = L"KiteDesktopVerification";
#else
constexpr wchar_t appFolder[] = L"KiteDesktop";
#endif
constexpr wchar_t title[] = L"Kite 桌面版安装";
constexpr wchar_t invalidLocation[] = L"请输入本地磁盘上的安装目录，例如 D:\\KiteDesktop。";

const auto release = [](auto* object) { object->Release(); };

std::wstring locationText(HWND dialog) {
  const HWND field = GetDlgItem(dialog, IDC_LOCATION);
  std::wstring value(static_cast<size_t>(GetWindowTextLengthW(field)) + 1, L'\0');
  const int count = GetWindowTextW(field, value.data(), static_cast<int>(value.size()));
  value.resize(count);
  return value;
}

bool hasDirectory(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool isKiteFolder(const std::wstring& path) {
  const size_t separator = path.find_last_of(L'\\');
  return (separator != path.npos && _wcsicmp(path.c_str() + separator + 1, appFolder) == 0) ||
    GetFileAttributesW((path + L"\\.kite-native-install.json").c_str()) != INVALID_FILE_ATTRIBUTES ||
    GetFileAttributesW((path + L"\\client\\.kite-native-install.json").c_str()) != INVALID_FILE_ATTRIBUTES;
}

void browse(HWND owner) {
  IFileOpenDialog* raw = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&raw))))
    throw std::wstring(L"无法打开文件夹选择器。请直接输入安装路径。");
  const std::unique_ptr<IFileOpenDialog, decltype(release)> picker(raw, release);
  FILEOPENDIALOGOPTIONS options = {};
  if (FAILED(picker->GetOptions(&options)) ||
      FAILED(picker->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
          FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT))) {
    throw std::wstring(L"无法打开文件夹选择器。请直接输入安装路径。");
  }
  const auto pickerTitle = L"选择存放 " + std::wstring(appFolder) + L" 的位置";
  picker->SetTitle(pickerTitle.c_str());
  picker->SetOkButtonLabel(L"选择文件夹");
  auto startingFolder = locationText(owner);
  while (startingFolder.size() > 3 && !hasDirectory(startingFolder)) {
    const auto separator = startingFolder.find_last_of(L'\\');
    if (separator == startingFolder.npos) break;
    startingFolder.resize((std::max)(separator, size_t{3}));
  }
  IShellItem* starting = nullptr;
  if (hasDirectory(startingFolder) &&
      SUCCEEDED(SHCreateItemFromParsingName(startingFolder.c_str(), nullptr, IID_PPV_ARGS(&starting)))) {
    const std::unique_ptr<IShellItem, decltype(release)> item(starting, release);
    picker->SetFolder(item.get());
  }

  const HRESULT outcome = picker->Show(owner);
  if (outcome == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return;
  IShellItem* selected = nullptr;
  if (FAILED(outcome) || FAILED(picker->GetResult(&selected))) throw std::wstring(invalidLocation);
  const std::unique_ptr<IShellItem, decltype(release)> item(selected, release);
  wchar_t* rawPath = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &rawPath))) throw std::wstring(invalidLocation);
  const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> path(rawPath, CoTaskMemFree);
  std::wstring value(path.get());
  if (value.empty()) throw std::wstring(invalidLocation);
  if (!isKiteFolder(value)) {
    if (value.back() != L'\\') value += L'\\';
    value += appFolder;
  }
  value = installationLocation(value);
  SetDlgItemTextW(owner, IDC_LOCATION, value.c_str());
  SendDlgItemMessageW(owner, IDC_LOCATION, EM_SETSEL, value.size(), value.size());
}

INT_PTR CALLBACK locationDialog(HWND dialog, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_INITDIALOG) {
    SetWindowLongPtrW(dialog, DWLP_USER, lparam);
    const auto* selection = reinterpret_cast<const SetupSelection*>(lparam);
    SetDlgItemTextW(dialog, IDC_LOCATION, selection->location.c_str());
    SendDlgItemMessageW(dialog, IDC_LOCATION, EM_SETLIMITTEXT, 32760, 0);
    CheckDlgButton(dialog, IDC_DESKTOP_SHORTCUT, selection->desktopShortcut ? BST_CHECKED : BST_UNCHECKED);
    SendMessageW(dialog, WM_SETICON, ICON_SMALL,
                 reinterpret_cast<LPARAM>(LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_KITE))));
    if (selection->upgrade) {
      SetDlgItemTextW(dialog, IDC_SETUP_HEADING, L"更新 Kite 桌面版");
      SetDlgItemTextW(dialog, IDC_SETUP_DETAIL, L"已找到现有安装。将在原目录更新并保留个人数据。");
      SetDlgItemTextW(dialog, IDOK, L"更新(&I)");
      SendDlgItemMessageW(dialog, IDC_LOCATION, EM_SETREADONLY, TRUE, 0);
      EnableWindow(GetDlgItem(dialog, IDC_BROWSE), FALSE);
      SetFocus(GetDlgItem(dialog, IDOK));
      return FALSE;
    }
    SetFocus(GetDlgItem(dialog, IDC_LOCATION));
    SendDlgItemMessageW(dialog, IDC_LOCATION, EM_SETSEL, selection->location.size(), selection->location.size());
    return FALSE;
  }
  if (message == WM_CLOSE) {
    EndDialog(dialog, IDCANCEL);
    return TRUE;
  }
  if (message != WM_COMMAND) return FALSE;
  try {
    switch (LOWORD(wparam)) {
      case IDC_BROWSE:
        browse(dialog);
        return TRUE;
      case IDOK: {
        auto* selection = reinterpret_cast<SetupSelection*>(GetWindowLongPtrW(dialog, DWLP_USER));
        selection->location = installationLocation(locationText(dialog));
        selection->desktopShortcut = IsDlgButtonChecked(dialog, IDC_DESKTOP_SHORTCUT) == BST_CHECKED;
        EndDialog(dialog, IDOK);
        return TRUE;
      }
      case IDCANCEL:
        EndDialog(dialog, IDCANCEL);
        return TRUE;
      default:
        return FALSE;
    }
  } catch (const std::wstring& error) {
    MessageBoxW(dialog, error.c_str(), title, MB_OK | MB_ICONWARNING);
    SetFocus(GetDlgItem(dialog, IDC_LOCATION));
    return TRUE;
  } catch (...) {
    MessageBoxW(dialog, L"无法读取安装位置。", title, MB_OK | MB_ICONERROR);
    return TRUE;
  }
}

} // namespace

std::wstring installationLocation(std::wstring location) {
  std::replace(location.begin(), location.end(), L'/', L'\\');
  while (location.size() > 3 && location.back() == L'\\') location.pop_back();
  if (location.size() < 3 || location.size() > 32760 || location[1] != L':' || location[2] != L'\\' ||
      !((location[0] >= L'A' && location[0] <= L'Z') || (location[0] >= L'a' && location[0] <= L'z')) ||
      location.find_first_of(L"<>\"|?*", 3) != location.npos) {
    throw std::wstring(invalidLocation);
  }
  const UINT drive = GetDriveTypeW(location.substr(0, 3).c_str());
  if (drive != DRIVE_FIXED && drive != DRIVE_REMOVABLE) throw std::wstring(invalidLocation);
  if (location.size() == 3) location += appFolder;
  return location;
}

bool selectInstallationLocation(SetupSelection& selection) {
  const INT_PTR result = DialogBoxParamW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_SETUP), nullptr,
      locationDialog, reinterpret_cast<LPARAM>(&selection));
  if (result == -1) throw std::wstring(L"无法打开 Kite 安装窗口。");
  return result == IDOK;
}
