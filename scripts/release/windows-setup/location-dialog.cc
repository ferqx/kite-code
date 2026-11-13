#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>

#include <algorithm>
#include <memory>
#include <string>

#include "location-dialog.h"
#include "payload.h"
#include "resource.h"

namespace {

#ifdef KITE_SETUP_FIXTURE
constexpr wchar_t appFolder[] = L"KiteDesktopVerification";
#else
constexpr wchar_t appFolder[] = L"KiteDesktop";
#endif
constexpr wchar_t title[] = L"Kite 桌面版安装向导";
constexpr wchar_t invalidLocation[] = L"请输入本机磁盘上的完整安装路径，例如 D:\\KiteDesktop。";
constexpr unsigned meterRange = 100;

struct DialogStyle {
  bool highContrast = false;
  bool cover = false;
  HBRUSH hero = nullptr;
  HBRUSH body = nullptr;
  HBRUSH footer = nullptr;
  HBRUSH divider = nullptr;
  HFONT heading = nullptr;
  HFONT status = nullptr;

  DialogStyle() {
    HIGHCONTRASTW settings{sizeof(settings)};
    highContrast = SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(settings), &settings, 0) &&
      (settings.dwFlags & HCF_HIGHCONTRASTON);
    hero = CreateSolidBrush(GetSysColor(COLOR_WINDOW));
    body = CreateSolidBrush(highContrast ? GetSysColor(COLOR_WINDOW) : RGB(240, 240, 240));
    footer = CreateSolidBrush(highContrast ? GetSysColor(COLOR_WINDOW) : RGB(240, 240, 240));
    divider = CreateSolidBrush(highContrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(186, 186, 186));
  }
  ~DialogStyle() {
    for (const auto brush : {hero, body, footer, divider}) if (brush) DeleteObject(brush);
    for (const auto font : {heading, status}) if (font) DeleteObject(font);
  }

  void scale(HWND window) {
    const UINT dpi = GetDpiForWindow(window);
    const auto setFont = [&](int id, int points, HFONT& previous) {
      const HWND control = GetDlgItem(window, id);
      if (!control) return;
      LOGFONTW font{};
      font.lfHeight = -MulDiv(points, dpi, 72);
      font.lfWeight = FW_SEMIBOLD;
      wcscpy_s(font.lfFaceName, L"Segoe UI");
      const auto replacement = CreateFontIndirectW(&font);
      if (!replacement) return;
      SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(replacement), TRUE);
      if (previous) DeleteObject(previous);
      previous = replacement;
    };
    setFont(IDC_SETUP_HEADING, cover ? 15 : 10, heading);
    setFont(IDC_SETUP_STATUS, 10, status);
    const auto size = MulDiv(32, dpi, 96);
    const auto icon = LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_KITE), IMAGE_ICON,
                                 size, size, LR_SHARED);
    SendDlgItemMessageW(window, IDC_SETUP_ICON, STM_SETICON, reinterpret_cast<WPARAM>(icon), 0);
    SendMessageW(window, WM_SETICON, ICON_SMALL,
                 reinterpret_cast<LPARAM>(LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_KITE))));
  }
};

void paintKiteArtwork(HDC dc, const RECT& bounds) {
  const int saved = SaveDC(dc);
  if (!saved) return;
  IntersectClipRect(dc, bounds.left, bounds.top, bounds.right, bounds.bottom);
  const auto point = [&](int x, int y) -> POINT {
    return {bounds.left + MulDiv(x, bounds.right - bounds.left, 110),
            bounds.top + MulDiv(y, bounds.bottom - bounds.top, 182)};
  };
  const auto facet = [&](COLORREF color, POINT first, POINT second, POINT third, POINT fourth) {
    const auto brush = CreateSolidBrush(color);
    if (!brush) return;
    const POINT points[]{first, second, third, fourth};
    const auto previous = SelectObject(dc, brush);
    Polygon(dc, points, ARRAYSIZE(points));
    SelectObject(dc, previous);
    DeleteObject(brush);
  };
  SelectObject(dc, GetStockObject(NULL_PEN));
  const auto backdrop = CreateSolidBrush(RGB(16, 48, 38));
  if (backdrop) {
    FillRect(dc, &bounds, backdrop);
    DeleteObject(backdrop);
  }
  facet(RGB(22, 63, 48), point(0, 119), point(110, 67), point(110, 182), point(0, 182));
  const auto thread = CreatePen(PS_SOLID, 2, RGB(194, 226, 205));
  if (thread) {
    const POINT line[]{point(49, 89), point(53, 110), point(65, 122), point(84, 135),
                       point(77, 154), point(49, 165), point(41, 186)};
    const auto previous = SelectObject(dc, thread);
    PolyBezier(dc, line, ARRAYSIZE(line));
    SelectObject(dc, previous);
    DeleteObject(thread);
  }
  const auto top = point(77, 23), left = point(17, 53), middle = point(64, 57);
  const auto right = point(102, 65), bottom = point(49, 100);
  facet(RGB(194, 234, 173), top, left, middle, middle);
  facet(RGB(123, 203, 152), top, middle, right, right);
  facet(RGB(81, 168, 129), left, bottom, middle, middle);
  facet(RGB(44, 135, 108), middle, bottom, right, right);
  RestoreDC(dc, saved);
}

LRESULT CALLBACK paintDialog(HWND window, UINT message, WPARAM wparam, LPARAM lparam,
                            UINT_PTR id, DWORD_PTR data) {
  const auto style = reinterpret_cast<DialogStyle*>(data);
  if (message == WM_ERASEBKGND) {
    const HDC dc = reinterpret_cast<HDC>(wparam);
    RECT client{}, bands{0, 35, 110, 182};
    GetClientRect(window, &client);
    MapDialogRect(window, &bands);
    if (style->cover) {
      const RECT page{0, 0, client.right, bands.bottom};
      FillRect(dc, &page, style->hero);
      const RECT art{0, 0, bands.right, bands.bottom};
      if (!style->highContrast) paintKiteArtwork(dc, art);
    } else {
      const RECT hero{0, 0, client.right, bands.top};
      const RECT headerLine{0, bands.top, client.right, bands.top + 1};
      const RECT body{0, bands.top + 1, client.right, bands.bottom};
      FillRect(dc, &hero, style->hero);
      FillRect(dc, &headerLine, style->divider);
      FillRect(dc, &body, style->body);
    }
    const RECT footerLine{0, bands.bottom, client.right, bands.bottom + 1};
    const RECT footer{0, bands.bottom + 1, client.right, client.bottom};
    FillRect(dc, &footerLine, style->divider);
    FillRect(dc, &footer, style->footer);
    return TRUE;
  }
  if (message == WM_CTLCOLORSTATIC) {
    const HDC dc = reinterpret_cast<HDC>(wparam);
    const int control = GetDlgCtrlID(reinterpret_cast<HWND>(lparam));
    const bool hero = style->cover || control == IDC_SETUP_HEADING || control == IDC_SETUP_DETAIL ||
      control == IDC_SETUP_ICON;
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
    return reinterpret_cast<LRESULT>(hero ? style->hero : style->body);
  }
  if (message == WM_CTLCOLORDLG) return reinterpret_cast<LRESULT>(style->body);
  if (message == WM_DPICHANGED) {
    const auto result = DefSubclassProc(window, message, wparam, lparam);
    style->scale(window);
    return result;
  }
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(window, paintDialog, id);
    const auto result = DefSubclassProc(window, message, wparam, lparam);
    delete style;
    return result;
  }
  return DefSubclassProc(window, message, wparam, lparam);
}

void styleDialog(HWND window) {
  auto style = std::make_unique<DialogStyle>();
  if (SetWindowSubclass(window, paintDialog, 1, reinterpret_cast<DWORD_PTR>(style.get()))) {
    style->scale(window);
    style.release();
  }
}

void positionControl(HWND window, int control, RECT bounds) {
  MapDialogRect(window, &bounds);
  SetWindowPos(GetDlgItem(window, control), nullptr, bounds.left, bounds.top,
               bounds.right - bounds.left, bounds.bottom - bounds.top, SWP_NOACTIVATE | SWP_NOZORDER);
}

void coverPage(HWND window, bool cover) {
  DWORD_PTR data = 0;
  if (GetWindowSubclass(window, paintDialog, 1, &data)) {
    auto* style = reinterpret_cast<DialogStyle*>(data);
    if (style->cover != cover) {
      style->cover = cover;
      style->scale(window);
    }
  }
  positionControl(window, IDC_SETUP_HEADING, cover ? RECT{125, 11, 334, 47} : RECT{11, 6, 295, 20});
  ShowWindow(GetDlgItem(window, IDC_SETUP_ICON), cover ? SW_HIDE : SW_SHOW);
  ShowWindow(GetDlgItem(window, IDC_SETUP_DETAIL), cover ? SW_HIDE : SW_SHOW);
  RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN);
}

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

std::wstring existingDirectory(std::wstring path) {
  while (path.size() > 3 && !hasDirectory(path)) {
    const auto separator = path.find_last_of(L'\\');
    if (separator == path.npos) return L"";
    path.resize((std::max)(separator, size_t{3}));
  }
  return hasDirectory(path) ? path : L"";
}

void updateDiskSpace(HWND dialog) {
  constexpr double mebibyte = 1024 * 1024;
  wchar_t details[128]{};
  swprintf_s(details, L"应用文件大小：%.1f MiB", installedPayloadBytes / mebibyte);
  std::wstring text(details);
  try {
    const auto folder = existingDirectory(installationLocation(locationText(dialog)));
    ULARGE_INTEGER available{};
    if (!folder.empty() && GetDiskFreeSpaceExW(folder.c_str(), &available, nullptr, nullptr)) {
      swprintf_s(details, L"\n可用空间：%.1f GiB", static_cast<double>(available.QuadPart) / (mebibyte * 1024));
      text += details;
    }
  } catch (const std::wstring&) {
    // Incomplete paths are normal while editing.
  }
  SetDlgItemTextW(dialog, IDC_SETUP_DISK_SPACE, text.c_str());
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
  const auto startingFolder = existingDirectory(locationText(owner));
  IShellItem* starting = nullptr;
  if (!startingFolder.empty() &&
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

enum class InstallPage { welcome, directory, shortcuts };

struct InstallWizard {
  SetupSelection& selection;
  InstallPage page;
};

void showInstallPage(HWND dialog, InstallWizard& wizard) {
  const bool welcome = wizard.page == InstallPage::welcome;
  const bool directory = wizard.page == InstallPage::directory;
  const bool shortcuts = wizard.page == InstallPage::shortcuts;
  coverPage(dialog, welcome);
  SetDlgItemTextW(dialog, IDC_SETUP_HEADING, welcome ? L"欢迎使用 Kite 桌面版\n安装向导" :
                    directory ? L"选择安装位置" : L"设置快捷方式");
  SetDlgItemTextW(dialog, IDC_SETUP_DETAIL, directory ? L"选择要安装 Kite 桌面版的文件夹。" :
                    L"选择在何处创建 Kite 快捷方式。");
  positionControl(dialog, IDC_SETUP_PROGRESS_DETAIL, welcome ? RECT{125, 54, 334, 151} : RECT{16, 47, 330, 76});
  SetDlgItemTextW(dialog, IDC_SETUP_PROGRESS_DETAIL,
    welcome ? L"此向导将为当前 Windows 用户安装 Kite 桌面版。\n\n单击「下一步」继续。" :
    directory ? L"Kite 桌面版将安装到下方的文件夹。要更改位置，请单击「浏览」或输入路径。\n单击「下一步」继续。" :
    L"安装程序会在 Windows 开始菜单中添加 Kite Desktop。\n如果也希望从桌面打开 Kite，请勾选下方选项。");
  for (const int control : {IDC_SETUP_LOCATION_GROUP, IDC_LOCATION, IDC_BROWSE, IDC_SETUP_DISK_SPACE})
    ShowWindow(GetDlgItem(dialog, control), directory ? SW_SHOW : SW_HIDE);
  ShowWindow(GetDlgItem(dialog, IDC_DESKTOP_SHORTCUT), shortcuts ? SW_SHOW : SW_HIDE);
  ShowWindow(GetDlgItem(dialog, IDC_SETUP_BACK), welcome ? SW_HIDE : SW_SHOW);
  SetDlgItemTextW(dialog, IDOK, shortcuts ? L"安装(&I)" : L"下一步(&N) >");
  SendMessageW(dialog, DM_SETDEFID, IDOK, 0);
  const int focused = directory ? IDC_LOCATION : IDOK;
  SetFocus(GetDlgItem(dialog, focused));
  if (directory) {
    updateDiskSpace(dialog);
    SendDlgItemMessageW(dialog, IDC_LOCATION, EM_SETSEL, 0, -1);
  }
}

INT_PTR CALLBACK locationDialog(HWND dialog, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_INITDIALOG) {
    styleDialog(dialog);
    SetWindowLongPtrW(dialog, DWLP_USER, lparam);
    auto& wizard = *reinterpret_cast<InstallWizard*>(lparam);
    SetWindowTextW(dialog, title);
    SetDlgItemTextW(dialog, IDC_LOCATION, wizard.selection.location.c_str());
    SendDlgItemMessageW(dialog, IDC_LOCATION, EM_SETLIMITTEXT, 32760, 0);
    CheckDlgButton(dialog, IDC_DESKTOP_SHORTCUT, wizard.selection.desktopShortcut ? BST_CHECKED : BST_UNCHECKED);
    showInstallPage(dialog, wizard);
    return FALSE;
  }
  if (message == WM_CLOSE) {
    EndDialog(dialog, IDCANCEL);
    return TRUE;
  }
  if (message != WM_COMMAND) return FALSE;
  auto& wizard = *reinterpret_cast<InstallWizard*>(GetWindowLongPtrW(dialog, DWLP_USER));
  try {
    switch (LOWORD(wparam)) {
      case IDC_LOCATION:
        if (HIWORD(wparam) == EN_CHANGE && wizard.page == InstallPage::directory) updateDiskSpace(dialog);
        return TRUE;
      case IDC_BROWSE:
        browse(dialog);
        return TRUE;
      case IDC_SETUP_BACK:
        if (wizard.page == InstallPage::welcome) return TRUE;
        wizard.page = wizard.page == InstallPage::shortcuts ? InstallPage::directory : InstallPage::welcome;
        showInstallPage(dialog, wizard);
        return TRUE;
      case IDOK:
        if (wizard.page == InstallPage::shortcuts) {
          wizard.selection.desktopShortcut = IsDlgButtonChecked(dialog, IDC_DESKTOP_SHORTCUT) == BST_CHECKED;
          EndDialog(dialog, IDOK);
          return TRUE;
        }
        if (wizard.page == InstallPage::directory) {
          wizard.selection.location = installationLocation(locationText(dialog));
          SetDlgItemTextW(dialog, IDC_LOCATION, wizard.selection.location.c_str());
          wizard.page = InstallPage::shortcuts;
        } else {
          wizard.page = InstallPage::directory;
        }
        showInstallPage(dialog, wizard);
        return TRUE;
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

bool showInstallWizard(SetupSelection& selection, bool chooseLocationAgain) {
  InstallWizard wizard{selection, chooseLocationAgain ? InstallPage::directory : InstallPage::welcome};
  const INT_PTR result = DialogBoxParamW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_SETUP_WIZARD), nullptr,
      locationDialog, reinterpret_cast<LPARAM>(&wizard));
  if (result == -1) throw std::wstring(L"无法打开 Kite 安装窗口。");
  return result == IDOK;
}

SetupProgress::SetupProgress(bool visible, const wchar_t* heading, const wchar_t* context)
    : operation(heading), subtitle(context) {
  if (!visible) return;
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS};
  if (!InitCommonControlsEx(&controls)) throw std::wstring(L"无法初始化安装进度窗口。");
  window = CreateDialogParamW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_SETUP_PROGRESS),
                              nullptr, dispatch, reinterpret_cast<LPARAM>(this));
  if (!window) throw std::wstring(L"无法打开安装进度窗口。");
  SetWindowTextW(window, heading);
  SetDlgItemTextW(window, IDC_SETUP_HEADING, heading);
  SetDlgItemTextW(window, IDC_SETUP_DETAIL, subtitle);
  SendDlgItemMessageW(window, IDC_SETUP_METER, PBM_SETRANGE32, 0, meterRange);
}

SetupProgress::~SetupProgress() {
  if (window) DestroyWindow(window);
}

INT_PTR CALLBACK SetupProgress::dispatch(HWND dialog, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_INITDIALOG) {
    SetWindowLongPtrW(dialog, DWLP_USER, lparam);
    styleDialog(dialog);
    ShowWindow(GetDlgItem(dialog, IDC_SETUP_PATH), SW_HIDE);
    ShowWindow(GetDlgItem(dialog, IDC_SETUP_LAUNCH), SW_HIDE);
    ShowWindow(GetDlgItem(dialog, IDC_SETUP_BACK), SW_HIDE);
    return TRUE;
  }
  const auto self = reinterpret_cast<SetupProgress*>(GetWindowLongPtrW(dialog, DWLP_USER));
  if (!self) return FALSE;
  if (message == WM_CLOSE) {
    if (self->choosing) self->choice = IDCANCEL;
    return TRUE;
  }
  if (message == WM_COMMAND && (LOWORD(wparam) == IDOK || LOWORD(wparam) == IDCANCEL)) {
    if (self->choosing) self->choice = LOWORD(wparam);
    return TRUE;
  }
  return FALSE;
}

void SetupProgress::pump() {
  if (!window) return;
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    if (message.message == WM_QUIT) {
      PostQuitMessage(static_cast<int>(message.wParam));
      break;
    }
    if (IsDialogMessageW(window, &message)) continue;
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

void SetupProgress::step(unsigned number, const wchar_t* label) {
  if (!window) return;
  const auto detail = L"步骤 " + std::to_wstring(number) + L"/3  ·  " + label;
  SetDlgItemTextW(window, IDC_SETUP_DETAIL, detail.c_str());
}

void SetupProgress::stage(const wchar_t* heading, SetupProgressRange nextRange) {
  if (!window) return;
  range = nextRange;
  advance(range.start);
  EnableMenuItem(GetSystemMenu(window, FALSE), SC_CLOSE, MF_BYCOMMAND | MF_GRAYED);
  const bool hadActions = IsWindowEnabled(GetDlgItem(window, IDOK));
  if (hadActions) {
    coverPage(window, false);
    EnableWindow(GetDlgItem(window, IDOK), FALSE);
    EnableWindow(GetDlgItem(window, IDCANCEL), FALSE);
    SetDlgItemTextW(window, IDOK, L"下一步 >");
    SetDlgItemTextW(window, IDCANCEL, L"取消");
    ShowWindow(GetDlgItem(window, IDC_SETUP_BACK), SW_SHOW);
    ShowWindow(GetDlgItem(window, IDOK), SW_SHOW);
    ShowWindow(GetDlgItem(window, IDCANCEL), SW_SHOW);
    positionControl(window, IDC_SETUP_PROGRESS_DETAIL, {16, 75, 330, 92});
    SetDlgItemTextW(window, IDC_SETUP_HEADING, operation);
  }
  ShowWindow(GetDlgItem(window, IDC_SETUP_PATH), SW_HIDE);
  ShowWindow(GetDlgItem(window, IDC_SETUP_LAUNCH), SW_HIDE);
  ShowWindow(GetDlgItem(window, IDC_SETUP_STATUS), SW_SHOW);
  ShowWindow(GetDlgItem(window, IDC_SETUP_OVERALL), SW_SHOW);
  ShowWindow(GetDlgItem(window, IDC_SETUP_METER), SW_SHOW);
  SetDlgItemTextW(window, IDC_SETUP_STATUS, heading);
  SetDlgItemTextW(window, IDC_SETUP_PROGRESS_DETAIL, L"");
  if (!IsWindowVisible(window)) {
    ShowWindow(window, SW_SHOW);
    UpdateWindow(window);
  } else if (hadActions) {
    InvalidateRect(window, nullptr, TRUE);
  }
}

void SetupProgress::count(uint64_t completed, uint64_t total, SetupCount unit) {
  if (!window) return;
  std::wstring detail;
  if (total) {
    if (unit == SetupCount::bytes) {
      wchar_t text[128]{};
      swprintf_s(text, L"已处理 %.1f / %.1f MiB", static_cast<double>(completed) / 1048576,
                 static_cast<double>(total) / 1048576);
      detail = text;
    } else {
      const auto verb = unit == SetupCount::checkedFiles ? L"已校验 " :
                        unit == SetupCount::writtenFiles ? L"已写入 " : L"已移除 ";
      detail = std::wstring(verb) +
        std::to_wstring(completed) + L" / " + std::to_wstring(total) +
        (unit == SetupCount::removedEntries ? L" 个文件和目录" : L" 个文件");
    }
  } else {
    detail = L"已检查 " + std::to_wstring(completed) + L" 个文件";
  }
  SetDlgItemTextW(window, IDC_SETUP_PROGRESS_DETAIL, detail.c_str());
  if (total && range.end > range.start)
    advance(range.start + static_cast<unsigned>((range.end - range.start) * (std::min)(completed, total) / total));
}

void SetupProgress::advance(unsigned next) {
  if (!window || next <= position) return;
  position = next;
  const auto label = L"总进度 " + std::to_wstring(position) + L"%";
  SetDlgItemTextW(window, IDC_SETUP_OVERALL, label.c_str());
  SendDlgItemMessageW(window, IDC_SETUP_METER, PBM_SETPOS, position, 0);
}

bool SetupProgress::choose(const wchar_t* heading, const wchar_t* detail, const wchar_t* primary,
                           const wchar_t* secondary, const wchar_t* location, bool offerLaunch) {
  if (!window) return false;
  choice = 0;
  choosing = true;
  EnableMenuItem(GetSystemMenu(window, FALSE), SC_CLOSE, MF_BYCOMMAND | MF_ENABLED);
  ShowWindow(GetDlgItem(window, IDC_SETUP_OVERALL), SW_HIDE);
  ShowWindow(GetDlgItem(window, IDC_SETUP_METER), SW_HIDE);
  ShowWindow(GetDlgItem(window, IDC_SETUP_STATUS), SW_HIDE);
  const bool complete = secondary == nullptr;
  coverPage(window, complete);
  positionControl(window, IDC_SETUP_PROGRESS_DETAIL, complete ? RECT{125, 54, 334, 108} : RECT{16, 51, 330, 103});
  SetDlgItemTextW(window, IDC_SETUP_HEADING, heading);
  SetDlgItemTextW(window, IDC_SETUP_DETAIL, subtitle);
  SetDlgItemTextW(window, IDC_SETUP_PROGRESS_DETAIL, detail);
  if (location) SetDlgItemTextW(window, IDC_SETUP_PATH, (L"安装目录  " + std::wstring(location)).c_str());
  ShowWindow(GetDlgItem(window, IDC_SETUP_PATH), location ? SW_SHOW : SW_HIDE);
  ShowWindow(GetDlgItem(window, IDC_SETUP_LAUNCH), offerLaunch ? SW_SHOW : SW_HIDE);
  if (offerLaunch) CheckDlgButton(window, IDC_SETUP_LAUNCH, BST_UNCHECKED);
  SetDlgItemTextW(window, IDOK, primary);
  SetDlgItemTextW(window, IDCANCEL, secondary ? secondary : L"取消");
  ShowWindow(GetDlgItem(window, IDC_SETUP_BACK), complete ? SW_SHOW : SW_HIDE);
  ShowWindow(GetDlgItem(window, IDOK), SW_SHOW);
  ShowWindow(GetDlgItem(window, IDCANCEL), SW_SHOW);
  EnableWindow(GetDlgItem(window, IDOK), TRUE);
  EnableWindow(GetDlgItem(window, IDCANCEL), !complete);
  InvalidateRect(window, nullptr, TRUE);
  if (!IsWindowVisible(window)) ShowWindow(window, SW_SHOW);
  const auto focused = secondary ? IDCANCEL : IDOK;
  SendMessageW(window, DM_SETDEFID, focused, 0);
  SetFocus(GetDlgItem(window, focused));
  MSG message{};
  while (!choice) {
    const BOOL result = GetMessageW(&message, nullptr, 0, 0);
    if (result <= 0) break;
    if (IsDialogMessageW(window, &message)) continue;
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  choosing = false;
  return choice == IDOK && (!offerLaunch || IsDlgButtonChecked(window, IDC_SETUP_LAUNCH) == BST_CHECKED);
}
