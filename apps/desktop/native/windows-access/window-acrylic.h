// Electron's system backdrop API starts at Windows 11 build 22621. Earlier
// builds expose acrylic through the legacy DWM accent-policy attribute.
namespace window_acrylic {
struct AccentPolicy {
  int state;
  DWORD flags;
  DWORD color;
  DWORD animation;
};
struct CompositionAttribute {
  int attribute;
  void* data;
  size_t size;
};
constexpr int kAccentPolicy = 19;
constexpr int kDisabled = 0;
constexpr int kAcrylicBlur = 4;

static bool effectsEnabled() {
  HIGHCONTRASTW contrast{sizeof(contrast), 0, nullptr};
  if (!SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0) ||
      (contrast.dwFlags & HCF_HIGHCONTRASTON) || GetSystemMetrics(SM_REMOTESESSION)) return false;

  SYSTEM_POWER_STATUS power{};
  if (GetSystemPowerStatus(&power) && power.SystemStatusFlag != 0) return false;

  DWORD enabled = 0;
  DWORD bytes = sizeof(enabled);
  const LSTATUS status = RegGetValueW(HKEY_CURRENT_USER,
      L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"EnableTransparency",
      RRF_RT_REG_DWORD, nullptr, &enabled, &bytes);
  return status == ERROR_FILE_NOT_FOUND || (status == ERROR_SUCCESS && enabled != 0);
}

static bool update(HWND window, bool dark) {
  using SetComposition = BOOL(WINAPI*)(HWND, const CompositionAttribute*);
  static const auto setComposition = reinterpret_cast<SetComposition>(
      GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetWindowCompositionAttribute"));
  if (!setComposition) return false;

  const bool enable = effectsEnabled();
  AccentPolicy policy{enable ? kAcrylicBlur : kDisabled, 0,
      enable ? (dark ? 0xcc1f1f1fUL : 0xccfafafaUL) : 0, 0};
  const CompositionAttribute attribute{kAccentPolicy, &policy, sizeof(policy)};
  if (enable && setComposition(window, &attribute)) {
    const MARGINS glass{-1, -1, -1, -1};
    if (SUCCEEDED(DwmExtendFrameIntoClientArea(window, &glass))) return true;
  }
  policy = {kDisabled, 0, 0, 0};
  setComposition(window, &attribute);
  const MARGINS solid{};
  DwmExtendFrameIntoClientArea(window, &solid);
  return false;
}

static napi_value apply(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t argc = 3, bytes = 0;
  void* data = nullptr;
  bool buffer = false, dark = false, applied = false;
  if (p_napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) == napi_ok && argc == 2 &&
      p_napi_is_buffer(env, args[0], &buffer) == napi_ok && buffer &&
      p_napi_get_buffer_info(env, args[0], &data, &bytes) == napi_ok && bytes == sizeof(HWND) &&
      p_napi_get_value_bool(env, args[1], &dark) == napi_ok) {
    HWND window;
    std::memcpy(&window, data, sizeof(window));
    DWORD process = 0;
    if (GetWindowThreadProcessId(window, &process) && process == GetCurrentProcessId() &&
        GetAncestor(window, GA_ROOT) == window) applied = update(window, dark);
  }
  return p_napi_get_boolean(env, applied, &result) == napi_ok ? result : nullptr;
}
}  // namespace window_acrylic
