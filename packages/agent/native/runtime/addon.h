#pragma once

#include <node_api.h>

#include <array>
#include <stdexcept>
#include <string>

namespace kite {
inline void check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("native_runtime_argument_invalid");
}

template <size_t Count> struct Args {
  std::array<napi_value, Count> values{};
  size_t size = Count;
  void* data = nullptr;

  Args(napi_env env, napi_callback_info info) {
    check(napi_get_cb_info(env, info, &size, values.data(), nullptr, &data));
  }

  napi_value operator[](size_t index) const {
    if (index >= size) throw std::runtime_error("native_runtime_argument_missing");
    return values[index];
  }
};

inline napi_valuetype type(napi_env env, napi_value value) {
  napi_valuetype result;
  check(napi_typeof(env, value, &result));
  return result;
}

inline std::string string(napi_env env, napi_value value) {
  size_t size;
  check(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
  std::string text(size + 1, '\0');
  check(napi_get_value_string_utf8(env, value, text.data(), text.size(), &size));
  text.resize(size);
  return text;
}

inline int32_t int32(napi_env env, napi_value value) {
  int32_t result;
  check(napi_get_value_int32(env, value, &result));
  return result;
}

inline napi_value integer(napi_env env, int32_t number) {
  napi_value result;
  check(napi_create_int32(env, number, &result));
  return result;
}

inline napi_value number(napi_env env, double number) {
  napi_value result;
  check(napi_create_double(env, number, &result));
  return result;
}

inline napi_value boolean(napi_env env, bool value) {
  napi_value result;
  check(napi_get_boolean(env, value, &result));
  return result;
}

inline napi_value null(napi_env env) {
  napi_value result;
  check(napi_get_null(env, &result));
  return result;
}

inline napi_value undefined(napi_env env) {
  napi_value result;
  check(napi_get_undefined(env, &result));
  return result;
}

inline napi_value text(napi_env env, const char* bytes, size_t size = NAPI_AUTO_LENGTH) {
  napi_value result;
  check(napi_create_string_utf8(env, bytes, size, &result));
  return result;
}

inline void set(napi_env env, napi_value target, const char* key, napi_value value) {
  check(napi_set_named_property(env, target, key, value));
}

template <typename F> napi_value guarded(napi_env env, F work) {
  try {
    return work();
  } catch (const std::exception& error) {
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

void defineFfi(napi_env env, napi_value exports);
void defineSqlite(napi_env env, napi_value exports);
}
