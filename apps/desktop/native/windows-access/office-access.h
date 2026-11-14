// Main-only Office storage below the original prepared Profile. No renderer paths or ACLs.
static const napi_type_tag officeTag = {0x6b6974656f666669, 0x6365707269766174};
struct OfficeLease {
  std::unique_ptr<Lease> held;
  void verify() { need(held != nullptr); held->verify(); }
  void release() { if (held) held->release(); }
};
static std::vector<std::unique_ptr<OfficeLease>> failedOfficeLeases;
static bool officeHex(const std::wstring& value, size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(),
    [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
struct OfficePath { std::vector<std::wstring> directories; std::wstring file; };
static OfficePath officePath(const std::wstring& relative) {
  if (relative == L"root") return {};
  std::vector<std::wstring> parts;
  for (size_t start = 0;;) {
    const auto at = relative.find(L'/', start);
    parts.push_back(relative.substr(start, at == std::wstring::npos ? at : at - start));
    need(parts.size() <= 2);
    if (at == std::wstring::npos) break;
    start = at + 1;
  }
  need(!parts.empty() && officeHex(parts[0], 64));
  OfficePath result{{parts[0]}, {}};
  if (parts.size() == 1) return result;
  const auto& second = parts[1];
  need(parts.size() == 2);
  if (second == L"current.json") { result.file = second; return result; }
  const auto dot = second.find_last_of(L'.');
  need(dot != std::wstring::npos);
  const auto stem = second.substr(0, dot), extension = second.substr(dot);
  need(extension == L".pptx" || extension == L".json");
  const bool revision = !stem.empty() && stem.size() <= 3 &&
    (stem.size() == 1 || stem.front() != L'0') &&
    std::all_of(stem.begin(), stem.end(), [](wchar_t c) { return c >= L'0' && c <= L'9'; }) &&
    std::stoul(stem) <= 100;
  need(revision);
  result.file = second;
  return result;
}
static void finalizeOffice(napi_env, void* data, void*) {
  std::unique_ptr<OfficeLease> lease(static_cast<OfficeLease*>(data));
  try { lease->release(); } catch (...) { failedOfficeLeases.push_back(std::move(lease)); }
}
static napi_value officeOperation(napi_env env, napi_callback_info info) {
  try {
    napi_value self, args[1]; void* action; size_t argc = 1;
    check(p_napi_get_cb_info(env, info, &argc, args, &self, &action)); need(argc == 0);
    tagged(env, self, officeTag);
    OfficeLease* lease; check(p_napi_unwrap(env, self, reinterpret_cast<void**>(&lease)));
    if (action) lease->release(); else lease->verify();
    napi_value result; check(p_napi_get_undefined(env, &result)); return result;
  } catch (const std::exception& error) { return failure(env, error); }
  catch (...) { p_napi_throw_error(env, "windows_access_unavailable", "windows_access_unavailable"); return nullptr; }
}
static napi_value officeFactory(napi_env env, napi_callback_info callback) {
  std::unique_ptr<OfficeLease> lease;
  try {
    napi_value self, args[2]; size_t argc = 2; void* action;
    check(p_napi_get_cb_info(env, callback, &argc, args, &self, &action));
    need(argc == 1 && action == nullptr);
    tagged(env, self, leaseTag);
    Lease* source; check(p_napi_unwrap(env, self, reinterpret_cast<void**>(&source)));
    source->verifyPrivateUi();
    const auto requested = officePath(argument(env, args[0]));
    lease = std::make_unique<OfficeLease>();
    lease->held = std::make_unique<Lease>();
    auto& held = *lease->held;
    held.ancestors(source->profilePath, false);
    held.ancestors(parent(source->lockPath), false);
    held.pin(parent(source->profilePath), true, true);
    held.pin(source->profilePath, true, true);
    held.pin(parent(parent(source->lockPath)), true, true);
    held.pin(parent(source->lockPath), true, true);
    held.pin(source->profilePath + L"\\desktop-private", true, true);
    held.profilePath = source->profilePath;
    // SH on the original existing lock; this read capability never creates anything.
    held.lockPath = source->lockPath;
    held.lock = held.privateFile(held.lockPath, false, true);
    held.lockIdentity = info(held.lock.value, false);
    if (!LockFileEx(held.lock.value, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &held.region)) {
      if (GetLastError() == ERROR_LOCK_VIOLATION) throw std::runtime_error("owner_busy");
      need(false);
    }
    held.acquired = true;
    held.verify();
    need(same(held.lockIdentity, source->lockIdentity));
    auto path = source->profilePath + L"\\desktop-private\\office-editor";
    const auto existing = [](const std::wstring& target) {
      if (GetFileAttributesW(nativePath(target).c_str()) == INVALID_FILE_ATTRIBUTES) {
        const auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
          throw std::runtime_error("office_editor_revision_unavailable");
        need(false);
      }
    };
    existing(path); held.pin(path, true, true);
    for (const auto& part : requested.directories) {
      path += L"\\" + part;
      existing(path); held.pin(path, true, true);
    }
    if (!requested.file.empty()) {
      path += L"\\" + requested.file;
      existing(path); held.pinFile(path, true);
    }
    lease->verify(); source->verifyPrivateUi();
    napi_value object; check(p_napi_create_object(env, &object));
    for (const auto& method : {std::pair<const char*, void*>("verify", nullptr), {"release", reinterpret_cast<void*>(1)}}) {
      napi_value function; check(p_napi_create_function(env, method.first, NAPI_AUTO_LENGTH,
        officeOperation, method.second, &function));
      check(p_napi_set_named_property(env, object, method.first, function));
    }
    check(p_napi_type_tag_object(env, object, &officeTag));
    check(p_napi_wrap(env, object, lease.get(), finalizeOffice, nullptr, nullptr));
    lease.release(); return object;
  } catch (const std::exception& error) {
    if (lease) { try { lease->release(); } catch (...) {
      failedOfficeLeases.push_back(std::move(lease));
      p_napi_throw_error(env, "windows_access_close_unknown", "windows_access_close_unknown"); return nullptr;
    } }
    if (std::string(error.what()) == "office_editor_revision_unavailable") {
      p_napi_throw_error(env, "office_editor_revision_unavailable", "office_editor_revision_unavailable");
      return nullptr;
    }
    return failure(env, error);
  } catch (...) {
    if (lease) { try { lease->release(); } catch (...) {
      failedOfficeLeases.push_back(std::move(lease));
      p_napi_throw_error(env, "windows_access_close_unknown", "windows_access_close_unknown"); return nullptr;
    } }
    p_napi_throw_error(env, "windows_access_unavailable", "windows_access_unavailable"); return nullptr;
  }
}
