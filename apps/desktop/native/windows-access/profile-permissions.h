// Main-only, fixed Profile metadata inspection. No database/content reads and
// no caller-supplied path, SID or descriptor for repair.
struct ProfilePermissionIssue {
  std::wstring root, path, snapshot, backup;
  BY_HANDLE_FILE_INFORMATION identity{};
  BY_HANDLE_FILE_INFORMATION rootIdentity{};
  bool directory = true, repairable = false, attempted = false;
};
static std::wstring permissionSnapshot(HANDLE handle) {
  std::vector<unsigned char> bytes(131072);
  DWORD needed = 0;
  need(GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    bytes.data(), static_cast<DWORD>(bytes.size()), &needed));
  need(needed >= SECURITY_DESCRIPTOR_MIN_LENGTH && needed <= bytes.size());
  Local text;
  need(ConvertSecurityDescriptorToStringSecurityDescriptorW(bytes.data(), SDDL_REVISION_1,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    reinterpret_cast<LPWSTR*>(&text.value), nullptr));
  return static_cast<wchar_t*>(text.value);
}
static bool removableReadGrants(Policy& policy, HANDLE handle, bool directory) {
  // A write-exposed, foreign-owned, unprotected or malformed object is never
  // made apparently safe by resetting its ACL. Only extra read/execute grants.
  policy.acl(handle, directory, false);
  auto bytes = policy.securityBytes.data();
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision;
  need(GetSecurityDescriptorControl(bytes, &control, &revision));
  if (directory && !(control & SE_DACL_PROTECTED)) return false;
  PACL dacl = nullptr; BOOL present, defaulted;
  need(GetSecurityDescriptorDacl(bytes, &present, &dacl, &defaulted) && present && dacl);
  if (dacl->AceCount < 2) return false;
  size_t ownerGrants = 0, extras = 0;
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* raw; need(GetAce(dacl, i, &raw));
    auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || (ace->Header.AceFlags & ~0x13)) return false;
    if (EqualSid(&ace->SidStart, policy.sid)) {
      if (ace->Mask != FILE_ALL_ACCESS || (directory && (ace->Header.AceFlags & 3) != 3)) return false;
      ++ownerGrants;
    } else {
      if (ace->Mask & ~0xa01200a9u) return false;
      ++extras;
    }
  }
  return ownerGrants == 1 && extras > 0;
}
static std::wstring permissionBackupName(const std::wstring& root) {
  unsigned char bytes[16];
  need(BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0);
  std::wstring name = root + L"\\permissions-backup-";
  for (const auto byte : bytes) { name += L"0123456789abcdef"[byte >> 4]; name += L"0123456789abcdef"[byte & 15]; }
  return name + L".txt";
}
static std::unique_ptr<ProfilePermissionIssue> profilePermissionIssue(const std::wstring& root, const std::wstring& profile) {
  Policy policy;
  BY_HANDLE_FILE_INFORMATION rootIdentity{};
  const auto coordination = root + L"\\.coordination\\" + profileKey(root, profile);
  const auto selected = root + L"\\" + profile;
  std::vector<std::pair<std::wstring, bool>> paths = {
    {root, true}, {root + L"\\.coordination", true}, {coordination, true},
    {selected, true}, {selected + L"\\desktop-private", true},
    {coordination + L"\\profile-use.lock", false}
  };
  for (const auto base : {selected + L"\\core.db", selected + L"\\desktop-private\\data.sqlite"})
    for (const auto suffix : {L"", L"-wal", L"-shm", L"-journal"}) paths.push_back({base + suffix, false});
  for (const auto& [path, directory] : paths) {
    const auto attributes = GetFileAttributesW(nativePath(path).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      need(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND);
      continue;
    }
    auto issue = std::make_unique<ProfilePermissionIssue>();
    issue->root = root; issue->path = path; issue->directory = directory;
    auto held = std::make_unique<Lease>();
    bool safe = false;
    try {
      held->ancestors(parent(path), false);
      auto& probe = held->probe(CreateFileW(nativePath(path).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
      canonicalHandle(probe.handle.value, path);
      issue->identity = info(probe.handle.value, directory);
      if (path == root) rootIdentity = issue->identity;
      issue->rootIdentity = rootIdentity;
      issue->snapshot = permissionSnapshot(probe.handle.value);
      try { policy.acl(probe.handle.value, directory, true); safe = true; }
      catch (...) {
        try { issue->repairable = removableReadGrants(policy, probe.handle.value, directory); }
        catch (...) { issue->repairable = false; }
      }
    } catch (...) { issue->repairable = false; }
    try { held->release(); }
    catch (...) { failedLeases.push_back(std::move(held)); throw std::runtime_error("windows_access_close_unknown"); }
    if (!safe) {
      if (issue->repairable) issue->backup = permissionBackupName(root);
      return issue;
    }
  }
  return nullptr;
}
static void repairProfilePermission(ProfilePermissionIssue& issue) {
  need(issue.repairable && !issue.attempted);
  issue.attempted = true;
  auto held = std::make_unique<Lease>();
  bool changing = false;
  std::exception_ptr failure;
  try {
    held->ancestors(parent(issue.root), false);
    // MAXIMUM_ALLOWED includes DELETE for our required owner-FA descriptor.
    // Existing Profile ancestor pins deny DELETE, so every live consumer blocks
    // this operation, and this pin blocks new consumers until strict close.
    // SetSecurityInfo on MAXIMUM_ALLOWED also deliberately does not propagate
    // inheritable ACEs to children: only the confirmed original object changes.
    auto maximum = [&](const std::wstring& path, bool directory) -> HANDLE {
      HANDLE raw = CreateFileW(nativePath(path).c_str(), MAXIMUM_ALLOWED,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
      if (raw == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION) throw std::runtime_error("owner_busy");
      auto& probe = held->probe(raw);
      canonicalHandle(raw, path); info(raw, directory);
      return probe.handle.value;
    };
    const auto root = maximum(issue.root, true);
    need(same(info(root, true), issue.rootIdentity));
    if (issue.path != issue.root) {
      // The root is pinned above; pin only intermediate descendants, never
      // reopen its DELETE-bearing HANDLE with incompatible share flags.
      auto path = parent(issue.path);
      while (path != issue.root) { held->pin(path, false, false); path = parent(path); }
    }
    const auto target = issue.path == issue.root ? root : maximum(issue.path, issue.directory);
    need(same(info(target, issue.directory), issue.identity));
    need(permissionSnapshot(target) == issue.snapshot && removableReadGrants(held->policy, target, issue.directory));
    if (issue.path != issue.root) held->policy.acl(root, true, true);
    auto sd = held->policy.descriptor(false);
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), sd.value, FALSE};
    auto& backup = held->probe(CreateFileW(nativePath(issue.backup).c_str(), GENERIC_WRITE | READ_CONTROL,
      FILE_SHARE_READ, &security, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    canonicalHandle(backup.handle.value, issue.backup); info(backup.handle.value, false);
    held->policy.acl(backup.handle.value, false, true);
    const auto identity = issue.identity;
    const auto record = utf8(L"Kite Windows permissions backup\r\nPath: " + issue.path +
      L"\r\nVolume: " + std::to_wstring(identity.dwVolumeSerialNumber) + L"\r\nFileID: " +
      std::to_wstring(identity.nFileIndexHigh) + L":" + std::to_wstring(identity.nFileIndexLow) +
      L"\r\nOwner/Group/DACL: " + issue.snapshot + L"\r\n");
    DWORD written = 0;
    need(WriteFile(backup.handle.value, record.data(), static_cast<DWORD>(record.size()), &written, nullptr) && written == record.size());
    need(FlushFileBuffers(backup.handle.value));
    held->closeProbe(backup);
    // Recheck the observed ACL after durable backup and immediately before mutation.
    need(permissionSnapshot(target) == issue.snapshot);
    auto privateSd = held->policy.descriptor(issue.directory);
    PACL dacl = nullptr; BOOL present, defaulted;
    need(GetSecurityDescriptorDacl(privateSd.value, &present, &dacl, &defaulted) && present && dacl);
    changing = true;
    need(SetSecurityInfo(target, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS);
    need(same(info(target, issue.directory), issue.identity));
    held->policy.acl(target, issue.directory, true);
  } catch (...) { failure = std::current_exception(); }
  try { held->release(); }
  catch (...) { failedLeases.push_back(std::move(held)); throw std::runtime_error("windows_access_close_unknown"); }
  if (failure) {
    if (changing) throw std::runtime_error("windows_profile_permission_repair_unknown");
    std::rethrow_exception(failure);
  }
}
static napi_value repairProfilePermissions(napi_env env, napi_callback_info callback) {
  try {
    napi_value self, args[1]; size_t argc = 1;
    check(p_napi_get_cb_info(env, callback, &argc, args, &self, nullptr));
    need(argc == 0);
    tagged(env, self, permissionTag);
    ProfilePermissionIssue* issue; check(p_napi_unwrap(env, self, reinterpret_cast<void**>(&issue)));
    repairProfilePermission(*issue);
    napi_value result; check(p_napi_get_undefined(env, &result)); return result;
  } catch (const std::exception& error) {
    const std::string reason(error.what());
    const auto code = reason == "owner_busy" || reason == "windows_access_close_unknown" || reason == "windows_profile_permission_repair_unknown"
      ? error.what() : "windows_profile_permission_repair_failed";
    p_napi_throw_error(env, code, code); return nullptr;
  } catch (...) { p_napi_throw_error(env, "windows_profile_permission_repair_failed", "windows_profile_permission_repair_failed"); return nullptr; }
}
static void finalizeProfilePermission(napi_env, void* data, void*) { delete static_cast<ProfilePermissionIssue*>(data); }
static napi_value inspectProfilePermissions(napi_env env, napi_callback_info callback) {
  try {
    napi_value args[3]; size_t argc = 3;
    check(p_napi_get_cb_info(env, callback, &argc, args, nullptr, nullptr)); need(argc == 2);
    const auto root = canonical(argument(env, args[0])), profile = argument(env, args[1]);
    need(profile.size() <= 64 && profile.front() != L'_' && profile.front() != L'-' &&
      std::all_of(profile.begin(), profile.end(), [](wchar_t c) { return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-'; }));
    auto issue = profilePermissionIssue(root, profile);
    napi_value result;
    if (!issue) { check(p_napi_get_undefined(env, &result)); return result; }
    check(p_napi_create_object(env, &result));
    for (const auto& item : {std::pair<const char*, std::wstring>("path", issue->path), {"backupPath", issue->backup}}) {
      napi_value value; check(p_napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(item.second.data()), item.second.size(), &value));
      check(p_napi_set_named_property(env, result, item.first, value));
    }
    napi_value repairable, repair;
    check(p_napi_get_boolean(env, issue->repairable, &repairable)); check(p_napi_set_named_property(env, result, "repairable", repairable));
    check(p_napi_create_function(env, "repair", NAPI_AUTO_LENGTH, repairProfilePermissions, nullptr, &repair));
    check(p_napi_set_named_property(env, result, "repair", repair));
    check(p_napi_type_tag_object(env, result, &permissionTag));
    check(p_napi_wrap(env, result, issue.get(), finalizeProfilePermission, nullptr, nullptr)); issue.release();
    return result;
  } catch (const std::exception& error) {
    const std::string reason(error.what());
    const auto code = reason == "windows_access_close_unknown" ? error.what() : "windows_profile_permission_inspection_failed";
    p_napi_throw_error(env, code, code); return nullptr;
  } catch (...) { p_napi_throw_error(env, "windows_profile_permission_inspection_failed", "windows_profile_permission_inspection_failed"); return nullptr; }
}
