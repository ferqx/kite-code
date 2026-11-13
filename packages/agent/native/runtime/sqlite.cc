#include "addon.h"
#include "library.h"

#include <sqlite3.h>

#include <cmath>
#include <filesystem>
#include <memory>
#include <mutex>
#include <unordered_set>

namespace kite {
namespace {
// Resolve SQLite from the exact selected release library, including the NOFOLLOW
// open and strict close APIs. Never bind to the host's builtin SQLite symbols.
#define KITE_SQLITE_APIS(F) \
  F(open_v2) F(close) F(errmsg) F(extended_errcode) F(exec) F(prepare_v2) F(step) F(reset) F(finalize) \
  F(bind_parameter_count) F(bind_parameter_name) F(bind_null) F(bind_int64) F(bind_double) \
  F(bind_text64) F(bind_blob64) F(clear_bindings) F(column_count) F(column_name) F(column_type) \
  F(column_int64) F(column_double) F(column_text) F(column_blob) F(column_bytes) \
  F(last_insert_rowid) F(changes64) F(get_autocommit)

struct Sqlite {
  LibraryHandle handle = nullptr;
  std::string path;
  bool unqualified = false;
#define DECLARE(name) decltype(&sqlite3_##name) name = nullptr;
  KITE_SQLITE_APIS(DECLARE)
#undef DECLARE
  ~Sqlite() {
    if (handle) closeLibrary(handle);
  }
};
std::mutex sqliteMutex;
std::unique_ptr<Sqlite> selected;

struct Statement;
struct Connection {
  Sqlite* api;
  sqlite3* db = nullptr;
  std::unordered_set<Statement*> statements;
  ~Connection() {
    if (db) api->close(db);
  }
};
using SharedConnection = std::shared_ptr<Connection>;
struct Statement {
  SharedConnection connection;
  sqlite3_stmt* stmt = nullptr;
  int finish() {
    if (!stmt) return SQLITE_OK;
    const auto result = connection->api->finalize(stmt);
    stmt = nullptr;
    connection->statements.erase(this);
    return result;
  }
  ~Statement() { finish(); }
};

constexpr int primaryCode(int result) { return result & 0xff; }

const char* resultCode(int result) {
#define KITE_SQLITE_CODE(name) case name: return #name;
  switch (result) {
    KITE_SQLITE_CODE(SQLITE_ERROR)
    KITE_SQLITE_CODE(SQLITE_INTERNAL)
    KITE_SQLITE_CODE(SQLITE_PERM)
    KITE_SQLITE_CODE(SQLITE_ABORT)
    KITE_SQLITE_CODE(SQLITE_BUSY)
    KITE_SQLITE_CODE(SQLITE_LOCKED)
    KITE_SQLITE_CODE(SQLITE_NOMEM)
    KITE_SQLITE_CODE(SQLITE_READONLY)
    KITE_SQLITE_CODE(SQLITE_INTERRUPT)
    KITE_SQLITE_CODE(SQLITE_IOERR)
    KITE_SQLITE_CODE(SQLITE_CORRUPT)
    KITE_SQLITE_CODE(SQLITE_NOTFOUND)
    KITE_SQLITE_CODE(SQLITE_FULL)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN)
    KITE_SQLITE_CODE(SQLITE_PROTOCOL)
    KITE_SQLITE_CODE(SQLITE_EMPTY)
    KITE_SQLITE_CODE(SQLITE_SCHEMA)
    KITE_SQLITE_CODE(SQLITE_TOOBIG)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT)
    KITE_SQLITE_CODE(SQLITE_MISMATCH)
    KITE_SQLITE_CODE(SQLITE_MISUSE)
    KITE_SQLITE_CODE(SQLITE_NOLFS)
    KITE_SQLITE_CODE(SQLITE_AUTH)
    KITE_SQLITE_CODE(SQLITE_FORMAT)
    KITE_SQLITE_CODE(SQLITE_RANGE)
    KITE_SQLITE_CODE(SQLITE_NOTADB)
    KITE_SQLITE_CODE(SQLITE_NOTICE)
    KITE_SQLITE_CODE(SQLITE_WARNING)
    KITE_SQLITE_CODE(SQLITE_ERROR_MISSING_COLLSEQ)
    KITE_SQLITE_CODE(SQLITE_ERROR_RETRY)
    KITE_SQLITE_CODE(SQLITE_ERROR_SNAPSHOT)
#ifdef SQLITE_ERROR_RESERVESIZE
    KITE_SQLITE_CODE(SQLITE_ERROR_RESERVESIZE)
#endif
#ifdef SQLITE_ERROR_KEY
    KITE_SQLITE_CODE(SQLITE_ERROR_KEY)
#endif
#ifdef SQLITE_ERROR_UNABLE
    KITE_SQLITE_CODE(SQLITE_ERROR_UNABLE)
#endif
    KITE_SQLITE_CODE(SQLITE_IOERR_READ)
    KITE_SQLITE_CODE(SQLITE_IOERR_SHORT_READ)
    KITE_SQLITE_CODE(SQLITE_IOERR_WRITE)
    KITE_SQLITE_CODE(SQLITE_IOERR_FSYNC)
    KITE_SQLITE_CODE(SQLITE_IOERR_DIR_FSYNC)
    KITE_SQLITE_CODE(SQLITE_IOERR_TRUNCATE)
    KITE_SQLITE_CODE(SQLITE_IOERR_FSTAT)
    KITE_SQLITE_CODE(SQLITE_IOERR_UNLOCK)
    KITE_SQLITE_CODE(SQLITE_IOERR_RDLOCK)
    KITE_SQLITE_CODE(SQLITE_IOERR_DELETE)
    KITE_SQLITE_CODE(SQLITE_IOERR_BLOCKED)
    KITE_SQLITE_CODE(SQLITE_IOERR_NOMEM)
    KITE_SQLITE_CODE(SQLITE_IOERR_ACCESS)
    KITE_SQLITE_CODE(SQLITE_IOERR_CHECKRESERVEDLOCK)
    KITE_SQLITE_CODE(SQLITE_IOERR_LOCK)
    KITE_SQLITE_CODE(SQLITE_IOERR_CLOSE)
    KITE_SQLITE_CODE(SQLITE_IOERR_DIR_CLOSE)
    KITE_SQLITE_CODE(SQLITE_IOERR_SHMOPEN)
    KITE_SQLITE_CODE(SQLITE_IOERR_SHMSIZE)
    KITE_SQLITE_CODE(SQLITE_IOERR_SHMLOCK)
    KITE_SQLITE_CODE(SQLITE_IOERR_SHMMAP)
    KITE_SQLITE_CODE(SQLITE_IOERR_SEEK)
    KITE_SQLITE_CODE(SQLITE_IOERR_DELETE_NOENT)
    KITE_SQLITE_CODE(SQLITE_IOERR_MMAP)
    KITE_SQLITE_CODE(SQLITE_IOERR_GETTEMPPATH)
    KITE_SQLITE_CODE(SQLITE_IOERR_CONVPATH)
    KITE_SQLITE_CODE(SQLITE_IOERR_VNODE)
    KITE_SQLITE_CODE(SQLITE_IOERR_AUTH)
    KITE_SQLITE_CODE(SQLITE_IOERR_BEGIN_ATOMIC)
    KITE_SQLITE_CODE(SQLITE_IOERR_COMMIT_ATOMIC)
    KITE_SQLITE_CODE(SQLITE_IOERR_ROLLBACK_ATOMIC)
    KITE_SQLITE_CODE(SQLITE_IOERR_DATA)
    KITE_SQLITE_CODE(SQLITE_IOERR_CORRUPTFS)
#ifdef SQLITE_IOERR_IN_PAGE
    KITE_SQLITE_CODE(SQLITE_IOERR_IN_PAGE)
#endif
#ifdef SQLITE_IOERR_BADKEY
    KITE_SQLITE_CODE(SQLITE_IOERR_BADKEY)
#endif
#ifdef SQLITE_IOERR_CODEC
    KITE_SQLITE_CODE(SQLITE_IOERR_CODEC)
#endif
    KITE_SQLITE_CODE(SQLITE_LOCKED_SHAREDCACHE)
    KITE_SQLITE_CODE(SQLITE_LOCKED_VTAB)
    KITE_SQLITE_CODE(SQLITE_BUSY_RECOVERY)
    KITE_SQLITE_CODE(SQLITE_BUSY_SNAPSHOT)
    KITE_SQLITE_CODE(SQLITE_BUSY_TIMEOUT)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_NOTEMPDIR)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_ISDIR)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_FULLPATH)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_CONVPATH)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_DIRTYWAL)
    KITE_SQLITE_CODE(SQLITE_CANTOPEN_SYMLINK)
    KITE_SQLITE_CODE(SQLITE_CORRUPT_VTAB)
    KITE_SQLITE_CODE(SQLITE_CORRUPT_SEQUENCE)
    KITE_SQLITE_CODE(SQLITE_CORRUPT_INDEX)
    KITE_SQLITE_CODE(SQLITE_READONLY_RECOVERY)
    KITE_SQLITE_CODE(SQLITE_READONLY_CANTLOCK)
    KITE_SQLITE_CODE(SQLITE_READONLY_ROLLBACK)
    KITE_SQLITE_CODE(SQLITE_READONLY_DBMOVED)
    KITE_SQLITE_CODE(SQLITE_READONLY_CANTINIT)
    KITE_SQLITE_CODE(SQLITE_READONLY_DIRECTORY)
    KITE_SQLITE_CODE(SQLITE_ABORT_ROLLBACK)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_CHECK)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_COMMITHOOK)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_FOREIGNKEY)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_FUNCTION)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_NOTNULL)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_PRIMARYKEY)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_TRIGGER)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_UNIQUE)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_VTAB)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_ROWID)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_PINNED)
    KITE_SQLITE_CODE(SQLITE_CONSTRAINT_DATATYPE)
    KITE_SQLITE_CODE(SQLITE_NOTICE_RECOVER_WAL)
    KITE_SQLITE_CODE(SQLITE_NOTICE_RECOVER_ROLLBACK)
#ifdef SQLITE_NOTICE_RBU
    KITE_SQLITE_CODE(SQLITE_NOTICE_RBU)
#endif
    KITE_SQLITE_CODE(SQLITE_WARNING_AUTOINDEX)
    KITE_SQLITE_CODE(SQLITE_AUTH_USER)
    default: return result == primaryCode(result) ? "SQLITE_ERROR" : resultCode(primaryCode(result));
  }
#undef KITE_SQLITE_CODE
}

void status(napi_env env, Connection& connection, int result) {
  if (result == SQLITE_OK) return;
  // Preserve SQLite's return modes and recover the extended code only when reporting a failure.
  if (connection.db && result == primaryCode(result)) {
    const int extended = connection.api->extended_errcode(connection.db);
    if (primaryCode(extended) == result) result = extended;
  }
  const auto message = connection.db ? connection.api->errmsg(connection.db) : "SQLite failed";
  napi_throw_error(env, resultCode(result), message);
  throw std::runtime_error("native_sqlite_failed");
}

template <typename T> T& external(napi_env env, napi_value value) {
  void* data;
  check(napi_get_value_external(env, value, &data));
  return *static_cast<T*>(data);
}

template <typename T> napi_value ownedExternal(napi_env env, std::unique_ptr<T> data) {
  napi_value result;
  check(napi_create_external(env, data.get(), [](napi_env, void* owned, void*) {
    delete static_cast<T*>(owned);
  }, nullptr, &result));
  data.release();
  return result;
}

Connection& database(napi_env env, napi_value value) {
  auto& db = *external<SharedConnection>(env, value);
  if (!db.db) throw std::runtime_error("native_sqlite_closed");
  return db;
}

Statement& statement(napi_env env, napi_value value) {
  auto& stmt = external<Statement>(env, value);
  if (!stmt.stmt) throw std::runtime_error("native_sqlite_statement_finalized");
  return stmt;
}

napi_value select(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<2> args(env, info);
    const auto path = string(env, args[0]);
    bool unqualified = false;
    if (args.size > 1) check(napi_get_value_bool(env, args[1], &unqualified));
    if (!std::filesystem::u8path(path).is_absolute() || path.find('\0') != std::string::npos)
      throw std::runtime_error("native_sqlite_selection_invalid");
    std::lock_guard<std::mutex> lock(sqliteMutex);
    if (selected) return boolean(env, selected->path == path && (unqualified || !selected->unqualified));
    auto api = std::make_unique<Sqlite>();
    api->path = path;
    api->unqualified = unqualified;
    api->handle = openSqliteLibrary(path);
    if (!api->handle) throw std::runtime_error("native_sqlite_library_unavailable");
#define LOAD(name) \
    api->name = reinterpret_cast<decltype(api->name)>(librarySymbol(api->handle, "sqlite3_" #name)); \
    if (!api->name) throw std::runtime_error("native_sqlite_symbol_unavailable:sqlite3_" #name);
    KITE_SQLITE_APIS(LOAD)
#undef LOAD
    selected = std::move(api);
    return boolean(env, true);
  });
}

napi_value isSelected(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<1> args(env, info);
    std::lock_guard<std::mutex> lock(sqliteMutex);
    return boolean(env, selected &&
        (args.size == 0 || (!selected->unqualified && selected->path == string(env, args[0]))));
  });
}

napi_value open(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<2> args(env, info);
    auto owner = std::make_shared<Connection>();
    {
      std::lock_guard<std::mutex> lock(sqliteMutex);
      if (!selected) throw std::runtime_error("native_sqlite_selection_missing");
      owner->api = selected.get();
    }
    const auto path = string(env, args[0]);
    if (path.find('\0') != std::string::npos) throw std::runtime_error("native_sqlite_path_invalid");
    constexpr int supported = SQLITE_OPEN_READONLY | SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
      SQLITE_OPEN_URI | SQLITE_OPEN_NOFOLLOW;
    const auto flags = int32(env, args[1]);
    if ((flags & ~supported) != 0) throw std::runtime_error("native_sqlite_flags_invalid");
    status(env, *owner, owner->api->open_v2(path.c_str(), &owner->db, flags | SQLITE_OPEN_NOFOLLOW,
                                          nullptr));
    return ownedExternal(env, std::make_unique<SharedConnection>(owner));
  });
}

napi_value close(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& db = *external<SharedConnection>(env, Args<1>(env, info)[0]);
    if (!db.db) return undefined(env);
    while (!db.statements.empty())
      status(env, db, (*db.statements.begin())->finish());
    status(env, db, db.api->close(db.db));
    db.db = nullptr;
    return undefined(env);
  });
}

napi_value prepare(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<2> args(env, info);
    auto prepared = std::make_unique<Statement>();
    prepared->connection = external<SharedConnection>(env, args[0]);
    auto& db = database(env, args[0]);
    const auto sql = string(env, args[1]);
    if (sql.size() >= INT32_MAX || sql.find('\0') != std::string::npos)
      throw std::runtime_error("native_sqlite_sql_invalid");
    status(env, db, db.api->prepare_v2(db.db, sql.c_str(), static_cast<int>(sql.size()) + 1,
                                      &prepared->stmt, nullptr));
    if (!prepared->stmt) throw std::runtime_error("native_sqlite_statement_missing");
    db.statements.insert(prepared.get());
    return ownedExternal(env, std::move(prepared));
  });
}

napi_value finalize(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& stmt = external<Statement>(env, Args<1>(env, info)[0]);
    status(env, *stmt.connection, stmt.finish());
    return undefined(env);
  });
}

napi_value exec(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<2> args(env, info);
    auto& db = database(env, args[0]);
    const auto sql = string(env, args[1]);
    if (sql.find('\0') != std::string::npos)
      throw std::runtime_error("native_sqlite_sql_invalid");
    status(env, db, db.api->exec(db.db, sql.c_str(), nullptr, nullptr, nullptr));
    return undefined(env);
  });
}

int bindValue(napi_env env, Statement& statement, int index, napi_value value) {
  const auto stmt = statement.stmt;
  const auto& api = *statement.connection->api;
  switch (type(env, value)) {
    case napi_null:
    case napi_undefined: return api.bind_null(stmt, index);
    case napi_boolean: {
      bool flag;
      check(napi_get_value_bool(env, value, &flag));
      return api.bind_int64(stmt, index, flag);
    }
    case napi_number: {
      double number;
      check(napi_get_value_double(env, value, &number));
      if (std::isfinite(number) && std::abs(number) <= 9007199254740991.0 && std::trunc(number) == number)
        return api.bind_int64(stmt, index, static_cast<int64_t>(number));
      return api.bind_double(stmt, index, number);
    }
    case napi_bigint: {
      int64_t number;
      bool exact;
      check(napi_get_value_bigint_int64(env, value, &number, &exact));
      if (!exact) return SQLITE_RANGE;
      return api.bind_int64(stmt, index, number);
    }
    case napi_string: {
      const auto bytes = string(env, value);
      return api.bind_text64(stmt, index, bytes.data(), bytes.size(), SQLITE_TRANSIENT, SQLITE_UTF8);
    }
    case napi_object: {
      bool typed, view, buffer;
      size_t length;
      void* data;
      check(napi_is_typedarray(env, value, &typed));
      check(napi_is_dataview(env, value, &view));
      check(napi_is_arraybuffer(env, value, &buffer));
      if (typed) {
        napi_typedarray_type kind;
        check(napi_get_typedarray_info(env, value, &kind, &length, &data, nullptr, nullptr));
        constexpr size_t bytes[] = {1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8};
        if (static_cast<size_t>(kind) >= std::size(bytes)) return SQLITE_MISMATCH;
        length *= bytes[kind];
      } else if (view) {
        check(napi_get_dataview_info(env, value, &length, &data, nullptr, nullptr));
      } else if (buffer) {
        check(napi_get_arraybuffer_info(env, value, &data, &length));
      } else {
        return SQLITE_MISMATCH;
      }
      return api.bind_blob64(stmt, index, length ? data : "", length, SQLITE_TRANSIENT);
    }
    default: return SQLITE_MISMATCH;
  }
}

napi_value start(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<4> args(env, info);
    auto& stmt = statement(env, args[0]);
    auto& db = *stmt.connection;
    bool named, strict;
    check(napi_get_value_bool(env, args[2], &named));
    check(napi_get_value_bool(env, args[3], &strict));
    status(env, db, db.api->reset(stmt.stmt));
    if (type(env, args[1]) == napi_null) return undefined(env);
    status(env, db, db.api->clear_bindings(stmt.stmt));
    const auto count = db.api->bind_parameter_count(stmt.stmt);
    if (named) {
      for (int index = 1; index <= count; ++index) {
        const auto* raw = db.api->bind_parameter_name(stmt.stmt, index);
        const auto name = raw ? std::string(raw) : "?" + std::to_string(index);
        const auto bare = name.c_str() + 1;
        const char* keys[] = {strict ? bare : name.c_str(), strict ? name.c_str() : bare};
        bool present = false;
        for (const auto* key : keys) {
          const auto property = text(env, key);
          check(napi_has_own_property(env, args[1], property, &present));
          if (!present) continue;
          napi_value value;
          check(napi_get_property(env, args[1], property, &value));
          status(env, db, bindValue(env, stmt, index, value));
          break;
        }
        if (strict && !present) status(env, db, SQLITE_RANGE);
      }
    } else {
      uint32_t size;
      check(napi_get_array_length(env, args[1], &size));
      if (size && size != static_cast<uint32_t>(count))
        status(env, db, SQLITE_RANGE);
      for (uint32_t i = 0; i < size; ++i) {
        napi_value value;
        check(napi_get_element(env, args[1], i, &value));
        status(env, db, bindValue(env, stmt, static_cast<int>(i) + 1, value));
      }
    }
    return undefined(env);
  });
}

napi_value column(napi_env env, Statement& stmt, int index, bool safe) {
  const auto& api = *stmt.connection->api;
  switch (api.column_type(stmt.stmt, index)) {
    case SQLITE_INTEGER: {
      const auto value = api.column_int64(stmt.stmt, index);
      if (!safe) return number(env, value);
      napi_value result;
      check(napi_create_bigint_int64(env, value, &result));
      return result;
    }
    case SQLITE_FLOAT: return number(env, api.column_double(stmt.stmt, index));
    case SQLITE_TEXT: {
      const auto bytes = reinterpret_cast<const char*>(api.column_text(stmt.stmt, index));
      if (!bytes) throw std::runtime_error("native_sqlite_column_unavailable");
      return text(env, bytes, api.column_bytes(stmt.stmt, index));
    }
    case SQLITE_BLOB: {
      const auto bytes = api.column_blob(stmt.stmt, index);
      const auto size = api.column_bytes(stmt.stmt, index);
      napi_value result;
      check(napi_create_buffer_copy(env, size, size ? bytes : "", nullptr, &result));
      return result;
    }
    default: return null(env);
  }
}

napi_value next(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    const Args<4> args(env, info);
    auto& stmt = statement(env, args[0]);
    auto& db = *stmt.connection;
    const int result = db.api->step(stmt.stmt);
    if (result == SQLITE_DONE) return null(env);
    if (result != SQLITE_ROW) status(env, db, result);
    bool safe, values, skip;
    check(napi_get_value_bool(env, args[1], &safe));
    check(napi_get_value_bool(env, args[2], &values));
    check(napi_get_value_bool(env, args[3], &skip));
    if (skip) return boolean(env, true);
    const int count = db.api->column_count(stmt.stmt);
    napi_value row;
    if (values) check(napi_create_array_with_length(env, count, &row));
    else check(napi_create_object(env, &row));
    for (int index = 0; index < count; ++index) {
      const auto value = column(env, stmt, index, safe);
      if (values) check(napi_set_element(env, row, index, value));
      else {
        const auto name = db.api->column_name(stmt.stmt, index);
        if (!name) throw std::runtime_error("native_sqlite_column_unavailable");
        const napi_property_descriptor property = {
          name, nullptr, nullptr, nullptr, nullptr, value, napi_default_jsproperty, nullptr
        };
        check(napi_define_properties(env, row, 1, &property));
      }
    }
    return row;
  });
}

napi_value reset(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& stmt = statement(env, Args<1>(env, info)[0]);
    // reset() reports the previous step error, which next() has already reported.
    stmt.connection->api->reset(stmt.stmt);
    return undefined(env);
  });
}

napi_value changes(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& db = database(env, Args<1>(env, info)[0]);
    napi_value result;
    check(napi_create_object(env, &result));
    set(env, result, "changes", number(env, db.api->changes64(db.db)));
    const auto rowid = db.api->last_insert_rowid(db.db);
    if (rowid < -9007199254740991LL || rowid > 9007199254740991LL) {
      napi_value bigint;
      check(napi_create_bigint_int64(env, rowid, &bigint));
      set(env, result, "lastInsertRowid", bigint);
    } else {
      set(env, result, "lastInsertRowid", number(env, rowid));
    }
    return result;
  });
}

napi_value inTransaction(napi_env env, napi_callback_info info) {
  return guarded(env, [&] {
    auto& db = database(env, Args<1>(env, info)[0]);
    return boolean(env, !db.api->get_autocommit(db.db));
  });
}
}

void defineSqlite(napi_env env, napi_value exports) {
  const napi_property_descriptor functions[] = {
    {"sqliteSelect", nullptr, select, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteIsSelected", nullptr, isSelected, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteOpen", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteClose", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqlitePrepare", nullptr, prepare, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteFinalize", nullptr, finalize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteExec", nullptr, exec, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteStart", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteNext", nullptr, next, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteReset", nullptr, reset, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteChanges", nullptr, changes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sqliteInTransaction", nullptr, inTransaction, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  check(napi_define_properties(env, exports, std::size(functions), functions));
}
}
