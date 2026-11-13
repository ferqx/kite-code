#include "addon.h"

NAPI_MODULE_INIT() {
  return kite::guarded(env, [&] {
    kite::defineFfi(env, exports);
    kite::defineSqlite(env, exports);
    return exports;
  });
}
