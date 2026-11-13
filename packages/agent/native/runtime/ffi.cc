#include "addon.h"
#include "library.h"

#ifdef _WIN32
#include "windows-ffi.h"
#elif defined(__APPLE__)
#include <ffi/ffi.h>
#else
#include <ffi.h>
#endif

#include <cmath>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <memory>
#include <string_view>
#include <vector>

namespace kite {
namespace {
struct Library {
  LibraryHandle handle = nullptr;
  std::string name;
  ~Library() {
    if (handle) closeLibrary(handle);
  }
};
using SharedLibrary = std::shared_ptr<Library>;

enum class Kind { Void, Bool, Int16, Uint16, Int32, Uint32, Int64, Uint64, Pointer };
Kind kind(napi_env env, napi_value value) {
  const std::string name = string(env, value);
  if (name == "void") return Kind::Void;
  if (name == "bool") return Kind::Bool;
  if (name == "i16") return Kind::Int16;
  if (name == "u16") return Kind::Uint16;
  if (name == "i32") return Kind::Int32;
  if (name == "u32") return Kind::Uint32;
  if (name == "i64") return Kind::Int64;
  if (name == "u64") return Kind::Uint64;
  if (name == "ptr") return Kind::Pointer;
  throw std::runtime_error("native_runtime_abi_unsupported");
}

#ifndef _WIN32
bool allowedSystemSymbol(const std::string& path, const std::string& symbol) {
  const auto matches = [&](std::initializer_list<std::string_view> names) {
    for (auto name : names)
      if (name == symbol) return true;
    return false;
  };
#ifdef __APPLE__
  if (path == "/System/Library/Frameworks/Security.framework/Versions/A/Security")
    return matches({"SecKeychainSetUserInteractionAllowed", "SecKeychainCopyDomainDefault",
        "SecKeychainFindGenericPassword", "SecKeychainItemFreeContent",
        "SecKeychainAddGenericPassword", "SecKeychainItemDelete"});
  if (path == "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation")
    return symbol == "CFRelease";
#else
  if (path == "libsecret-1.so.0")
    return matches({"secret_service_get_sync", "secret_service_ensure_session_sync",
        "secret_service_get_session_algorithms", "secret_service_get_session_dbus_path",
        "secret_service_encode_dbus_secret", "secret_service_decode_dbus_secret",
        "secret_collection_new_for_dbus_path_sync",
        "secret_collection_get_locked", "secret_value_new", "secret_value_get", "secret_value_unref"});
  if (path == "libgio-2.0.so.0")
    return matches({"g_dbus_proxy_get_connection", "g_dbus_proxy_get_name_owner",
        "g_dbus_connection_call_sync", "g_dbus_error_get_remote_error"});
  if (path == "libglib-2.0.so.0")
    return matches({"g_variant_new_string", "g_variant_new_object_path", "g_variant_new_boolean", "g_variant_new_tuple",
        "g_variant_new_variant", "g_variant_new_dict_entry", "g_variant_new_array",
        "g_variant_type_new", "g_variant_type_free", "g_variant_get_child_value",
        "g_variant_get_string", "g_variant_n_children", "g_variant_ref_sink", "g_variant_unref",
        "g_free", "g_error_free"});
  if (path == "libgobject-2.0.so.0") return symbol == "g_object_unref";
#endif
  return true;
}

ffi_type* ffiType(Kind kind) {
  switch (kind) {
    case Kind::Void: return &ffi_type_void;
    case Kind::Bool: return &ffi_type_sint32;
    case Kind::Int16: return &ffi_type_sint16;
    case Kind::Uint16: return &ffi_type_uint16;
    case Kind::Int32: return &ffi_type_sint32;
    case Kind::Uint32: return &ffi_type_uint32;
    case Kind::Int64: return &ffi_type_sint64;
    case Kind::Uint64: return &ffi_type_uint64;
    case Kind::Pointer: return &ffi_type_pointer;
  }
  throw std::runtime_error("native_runtime_abi_unsupported");
}
#endif

struct Function {
  SharedLibrary library;
  void* address;
#ifdef _WIN32
  WindowsCall invoke;
  bool lastError = false;
#else
  ffi_cif cif;
  std::vector<ffi_type*> types;
#endif
  std::vector<Kind> kinds;
  Kind result;
};

static_assert(sizeof(uintptr_t) == sizeof(uint64_t));

uint64_t unsigned64(napi_env env, napi_value value) {
  uint64_t result;
  if (type(env, value) == napi_bigint) {
    bool exact;
    check(napi_get_value_bigint_uint64(env, value, &result, &exact));
    if (!exact) throw std::runtime_error("native_runtime_uint64_invalid");
    return result;
  }
  double input;
  check(napi_get_value_double(env, value, &input));
  if (!std::isfinite(input) || input < 0 || input > 9007199254740991.0 || std::trunc(input) != input)
    throw std::runtime_error("native_runtime_uint64_invalid");
  return static_cast<uint64_t>(input);
}

int64_t signed64(napi_env env, napi_value value) {
  int64_t result;
  if (type(env, value) == napi_bigint) {
    bool exact;
    check(napi_get_value_bigint_int64(env, value, &result, &exact));
    if (!exact) throw std::runtime_error("native_runtime_int64_invalid");
    return result;
  }
  double input;
  check(napi_get_value_double(env, value, &input));
  if (!std::isfinite(input) || std::abs(input) > 9007199254740991.0 || std::trunc(input) != input)
    throw std::runtime_error("native_runtime_int64_invalid");
  return static_cast<int64_t>(input);
}

void* pointer(napi_env env, napi_value value) {
  if (type(env, value) == napi_null) return nullptr;
  return reinterpret_cast<void*>(static_cast<uintptr_t>(unsigned64(env, value)));
}

napi_value jsPointer(napi_env env, void* ptr) {
  const auto address = reinterpret_cast<uintptr_t>(ptr);
  if (address > 9007199254740991ULL) throw std::runtime_error("native_runtime_pointer_invalid");
  return ptr ? number(env, static_cast<double>(address)) : null(env);
}

uint64_t argument(napi_env env, napi_value value, Kind kind) {
  switch (kind) {
    case Kind::Bool: {
      if (type(env, value) != napi_boolean) return int32(env, value) != 0;
      bool input;
      check(napi_get_value_bool(env, value, &input));
      return input;
    }
    case Kind::Int16:
    case Kind::Uint16:
    case Kind::Int32: return static_cast<uint64_t>(int32(env, value));
    case Kind::Uint32: {
      uint32_t input;
      check(napi_get_value_uint32(env, value, &input));
      return input;
    }
    case Kind::Int64: return static_cast<uint64_t>(signed64(env, value));
    case Kind::Uint64: return unsigned64(env, value);
    case Kind::Pointer: return reinterpret_cast<uintptr_t>(pointer(env, value));
    case Kind::Void: throw std::runtime_error("native_runtime_void_argument");
  }
  throw std::runtime_error("native_runtime_abi_unsupported");
}

napi_value jsResult(napi_env env, uint64_t result, Kind kind) {
  napi_value bigint;
  switch (kind) {
    case Kind::Void: return undefined(env);
    case Kind::Bool: return boolean(env, static_cast<int32_t>(result) != 0);
    case Kind::Int16: return integer(env, static_cast<int16_t>(result));
    case Kind::Uint16: return integer(env, static_cast<uint16_t>(result));
    case Kind::Int32: return integer(env, static_cast<int32_t>(result));
    case Kind::Uint32: return number(env, static_cast<uint32_t>(result));
    case Kind::Int64:
      check(napi_create_bigint_int64(env, static_cast<int64_t>(result), &bigint));
      return bigint;
    case Kind::Uint64:
      check(napi_create_bigint_uint64(env, result, &bigint));
      return bigint;
    case Kind::Pointer: return jsPointer(env, reinterpret_cast<void*>(result));
  }
  throw std::runtime_error("native_runtime_abi_unsupported");
}

SharedLibrary& getLibrary(napi_env env, napi_value value) {
  void* data;
  check(napi_get_value_external(env, value, &data));
  auto& library = *static_cast<SharedLibrary*>(data);
  if (!library->handle) throw std::runtime_error("native_runtime_library_closed");
  return library;
}

napi_value open(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<1> args(env, info);
    const auto path = string(env, args[0]);
    auto library = std::make_unique<SharedLibrary>(std::make_shared<Library>());
#ifdef _WIN32
    (*library)->name = windowsSystemLibrary(path);
    (*library)->handle = LoadLibraryExA((*library)->name.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
#else
#ifdef __APPLE__
    const bool supported = path == "/usr/lib/libSystem.B.dylib" || path == "/usr/lib/libproc.dylib" ||
        path == "/System/Library/Frameworks/Security.framework/Versions/A/Security" ||
        path == "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation";
#else
    const bool supported = path == "libc.so.6" || path == "libsecret-1.so.0" ||
        path == "libglib-2.0.so.0" || path == "libgobject-2.0.so.0" || path == "libgio-2.0.so.0";
#endif
    if (!supported) throw std::runtime_error("native_runtime_library_unsupported");
    (*library)->name = path;
    (*library)->handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL
#ifdef __linux__
        | (path == "libc.so.6" ? RTLD_NOLOAD : RTLD_NODELETE)
#endif
    );
#endif
    if (!(*library)->handle) throw std::runtime_error("native_runtime_library_unavailable");
    napi_value result;
    check(napi_create_external(env, library.get(), [](napi_env, void* data, void*) {
      delete static_cast<SharedLibrary*>(data);
    }, nullptr, &result));
    library.release();
    return result;
  });
}

napi_value close(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& library = getLibrary(env, Args<1>(env, info)[0]);
    if (!closeLibrary(library->handle)) throw std::runtime_error("native_runtime_library_close_failed");
    library->handle = nullptr;
    return undefined(env);
  });
}

#ifdef _WIN32
thread_local DWORD windowsLastError = ERROR_SUCCESS;
#endif
napi_value call(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<17> args(env, info);
    const auto& function = *static_cast<Function*>(args.data);
    if (!function.library->handle) throw std::runtime_error("native_runtime_library_closed");
    if (args.size != function.kinds.size())
      throw std::runtime_error("native_runtime_arguments_invalid");
    std::array<uint64_t, 16> nativeArgs;
    for (size_t i = 0; i < args.size; ++i) {
      nativeArgs[i] = argument(env, args[i], function.kinds[i]);
    }
    uint64_t result = 0;
#ifdef _WIN32
    if (function.lastError) return number(env, windowsLastError);
    SetLastError(windowsLastError);
    result = function.invoke(function.address, nativeArgs.data());
    windowsLastError = GetLastError();
#else
    std::array<void*, 16> inputs;
    for (size_t i = 0; i < args.size; ++i) inputs[i] = &nativeArgs[i];
    ffi_call(const_cast<ffi_cif*>(&function.cif), FFI_FN(function.address), &result, inputs.data());
#endif
    return jsResult(env, result, function.result);
  });
}

napi_value bind(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<4> args(env, info);
    auto function = std::make_unique<Function>();
    function->library = getLibrary(env, args[0]);
    const auto symbol = string(env, args[1]);
    if (symbol.empty() || symbol.find('\0') != std::string::npos)
      throw std::runtime_error("native_runtime_symbol_invalid");
#ifndef _WIN32
    if (!allowedSystemSymbol(function->library->name, symbol))
      throw std::runtime_error("native_runtime_symbol_unsupported");
#endif
    function->address = librarySymbol(function->library->handle, symbol.c_str());
    if (!function->address) throw std::runtime_error("native_runtime_symbol_unavailable:" + symbol);
    uint32_t count;
    check(napi_get_array_length(env, args[2], &count));
    if (count > 16) throw std::runtime_error("native_runtime_arguments_invalid");
    std::string signature;
    for (uint32_t i = 0; i < count; ++i) {
      napi_value element;
      check(napi_get_element(env, args[2], i, &element));
      const auto input = kind(env, element);
      if (input == Kind::Void) throw std::runtime_error("native_runtime_void_argument");
      function->kinds.push_back(input);
#ifdef _WIN32
      if (!signature.empty()) signature += ',';
      signature += string(env, element);
#else
      function->types.push_back(ffiType(input));
#endif
    }
    function->result = kind(env, args[3]);
#ifdef _WIN32
    signature += ':' + string(env, args[3]);
    function->invoke = windowsCall(function->library->name, symbol, signature);
    function->lastError = symbol == "GetLastError";
#else
    auto* output = ffiType(function->result);
#ifdef __linux__
    const unsigned int fixed = symbol == "openat" ? 3 : symbol == "fcntl" ? 2 : symbol == "syscall" ? 1 : 0;
    const auto prepared = fixed
      ? ffi_prep_cif_var(&function->cif, FFI_DEFAULT_ABI, fixed, count, output, function->types.data())
      : ffi_prep_cif(&function->cif, FFI_DEFAULT_ABI, count, output, function->types.data());
#else
    const auto prepared = ffi_prep_cif(&function->cif, FFI_DEFAULT_ABI, count, output, function->types.data());
#endif
    if (prepared != FFI_OK)
      throw std::runtime_error("native_runtime_abi_invalid");
#endif
    napi_value result;
    check(napi_create_function(env, symbol.c_str(), symbol.size(), call, function.get(), &result));
    check(napi_add_finalizer(env, result, function.get(), [](napi_env, void* data, void*) {
      delete static_cast<Function*>(data);
    }, nullptr, nullptr));
    function.release();
    return result;
  });
}

napi_value ptr(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<1> args(env, info);
    void* address;
    bool typed;
    check(napi_is_typedarray(env, args[0], &typed));
    if (typed) {
      check(napi_get_typedarray_info(env, args[0], nullptr, nullptr, &address, nullptr, nullptr));
    } else {
      bool dataView;
      check(napi_is_dataview(env, args[0], &dataView));
      if (dataView)
        check(napi_get_dataview_info(env, args[0], nullptr, &address, nullptr, nullptr));
      else
        check(napi_get_arraybuffer_info(env, args[0], &address, nullptr));
    }
    if (!address) throw std::runtime_error("native_runtime_pointer_invalid");
    return jsPointer(env, address);
  });
}

napi_value view(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<3> args(env, info);
    auto* address = static_cast<unsigned char*>(pointer(env, args[0]));
    const auto offset = unsigned64(env, args[1]);
    const auto length = unsigned64(env, args[2]);
    if (!address || offset > 64 * 1024 * 1024 || length > 64 * 1024 * 1024)
      throw std::runtime_error("native_runtime_view_invalid");
    napi_value result;
    // This is a borrowed view. Its callers immediately read the original native object.
    check(napi_create_external_arraybuffer(env, address + offset, length, [](napi_env, void*, void*) {},
                                          nullptr, &result));
    return result;
  });
}

napi_value cstring(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<3> args(env, info);
    const auto* address = static_cast<const char*>(pointer(env, args[0]));
    const auto offset = unsigned64(env, args[1]);
    const auto limit = unsigned64(env, args[2]);
    if (!address || offset > 64 * 1024 * 1024 || !limit || limit > 64 * 1024)
      throw std::runtime_error("native_runtime_cstring_invalid");
    address += offset;
    for (size_t length = 0; length < limit; ++length) {
      if (address[length] == '\0') return text(env, address, length);
    }
    throw std::runtime_error("native_runtime_cstring_unterminated");
  });
}
}

void defineFfi(napi_env env, napi_value exports) {
  const napi_property_descriptor functions[] = {
    {"ffiOpen", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ffiClose", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ffiBind", nullptr, bind, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ffiPtr", nullptr, ptr, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ffiView", nullptr, view, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"ffiCString", nullptr, cstring, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  check(napi_define_properties(env, exports, std::size(functions), functions));
}
}
