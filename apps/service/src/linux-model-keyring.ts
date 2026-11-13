import { ConfigurationError } from '@kite-ai/agent/config';
import { CString, dlopen, type Pointer, ptr, toArrayBuffer } from '@kite-ai/agent/runtime-ffi';
import { type ModelKeyringOperation, runModelKeyringChild } from './model-keyring-process';

const serviceInterface = 'org.freedesktop.Secret.Service';
const collectionInterface = 'org.freedesktop.Secret.Collection';
const itemInterface = 'org.freedesktop.Secret.Item';
const servicePath = '/org/freedesktop/secrets';
const operationTimeoutMs = 3000;
const maxCredentialBytes = 65_536;
const moduleUrl = new URL(
  import.meta.url.endsWith('.ts') ? './linux-model-keyring.ts' : './linux-model-keyring.js',
  import.meta.url,
).href;

export function readLinuxModelKeyring(service: string, account: string): Promise<Buffer | null> {
  return runModelKeyringChild(moduleUrl, { operation: 'read', service, account });
}

export async function createLinuxModelKeyring(service: string, account: string, key: Buffer) {
  await runModelKeyringChild(moduleUrl, { operation: 'create', service, account, key });
}

export async function removeLinuxModelKeyring(service: string, account: string) {
  await runModelKeyringChild(moduleUrl, { operation: 'remove', service, account });
}

const cString = (value: string) => Buffer.from(`${value}\0`);
const requirePointer = (value: Pointer | null) => {
  if (!value) throw new ConfigurationError('credential_unavailable');
  return value;
};

/** Runs in the private Linux keyring subprocess. This path never calls Unlock or Prompt. */
export function modelKeyringOperation(input: ModelKeyringOperation): Buffer | null {
  if (process.platform !== 'linux')
    throw new ConfigurationError('model_credentials_backend_unavailable');
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.service) ||
    !/^[A-Za-z0-9._:/-]{1,256}$/u.test(input.account) ||
    !['read', 'create', 'remove'].includes(input.operation)
  )
    throw new ConfigurationError('credential_unavailable');

  const libraries: { close(): void }[] = [];
  function open<const S extends Parameters<typeof dlopen>[1]>(name: string, symbols: S) {
    try {
      const library = dlopen(name, symbols);
      libraries.push(library);
      return library.symbols;
    } catch {
      throw new ConfigurationError('model_credentials_backend_unavailable');
    }
  }

  try {
    const glib = open('libglib-2.0.so.0', {
      g_variant_new_string: { args: ['ptr'], returns: 'ptr' },
      g_variant_new_object_path: { args: ['ptr'], returns: 'ptr' },
      g_variant_new_boolean: { args: ['bool'], returns: 'ptr' },
      g_variant_new_tuple: { args: ['ptr', 'u64'], returns: 'ptr' },
      g_variant_new_array: { args: ['ptr', 'ptr', 'u64'], returns: 'ptr' },
      g_variant_new_variant: { args: ['ptr'], returns: 'ptr' },
      g_variant_new_dict_entry: { args: ['ptr', 'ptr'], returns: 'ptr' },
      g_variant_get_child_value: { args: ['ptr', 'u64'], returns: 'ptr' },
      g_variant_get_string: { args: ['ptr', 'ptr'], returns: 'ptr' },
      g_variant_n_children: { args: ['ptr'], returns: 'u64' },
      g_variant_ref_sink: { args: ['ptr'], returns: 'ptr' },
      g_variant_unref: { args: ['ptr'] },
      g_variant_type_new: { args: ['ptr'], returns: 'ptr' },
      g_variant_type_free: { args: ['ptr'] },
      g_free: { args: ['ptr'] },
      g_error_free: { args: ['ptr'] },
    });
    const gio = open('libgio-2.0.so.0', {
      g_dbus_proxy_get_connection: { args: ['ptr'], returns: 'ptr' },
      g_dbus_proxy_get_name_owner: { args: ['ptr'], returns: 'ptr' },
      g_dbus_connection_call_sync: {
        args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32', 'i32', 'ptr', 'ptr'],
        returns: 'ptr',
      },
      g_dbus_error_get_remote_error: { args: ['ptr'], returns: 'ptr' },
    });
    const object = open('libgobject-2.0.so.0', {
      g_object_unref: { args: ['ptr'] },
    });
    const secret = open('libsecret-1.so.0', {
      secret_service_get_sync: { args: ['u32', 'ptr', 'ptr'], returns: 'ptr' },
      secret_service_ensure_session_sync: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
      secret_service_get_session_algorithms: { args: ['ptr'], returns: 'ptr' },
      secret_service_get_session_dbus_path: { args: ['ptr'], returns: 'ptr' },
      secret_service_encode_dbus_secret: { args: ['ptr', 'ptr'], returns: 'ptr' },
      secret_service_decode_dbus_secret: { args: ['ptr', 'ptr'], returns: 'ptr' },
      secret_collection_new_for_dbus_path_sync: {
        args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'],
        returns: 'ptr',
      },
      secret_collection_get_locked: { args: ['ptr'], returns: 'bool' },
      secret_value_new: { args: ['ptr', 'i64', 'ptr'], returns: 'ptr' },
      secret_value_get: { args: ['ptr', 'ptr'], returns: 'ptr' },
      secret_value_unref: { args: ['ptr'] },
    });

    function checked<T>(work: (error: Pointer) => T, unavailable = 'credential_unavailable'): T {
      const error = new BigUint64Array(1);
      const result = work(ptr(error));
      if (!error[0]) return result;
      const nativeError = Number(error[0]);
      const name = gio.g_dbus_error_get_remote_error(nativeError);
      try {
        const code = name ? new CString(name, 0, 256).toString() : '';
        switch (code) {
          case 'org.freedesktop.Secret.Error.IsLocked':
            throw new ConfigurationError('model_credentials_locked');
          case 'org.freedesktop.Secret.Error.AlreadyExists':
            throw new ConfigurationError('credential_already_exists');
          case 'org.freedesktop.DBus.Error.ServiceUnknown':
          case 'org.freedesktop.DBus.Error.NameHasNoOwner':
            throw new ConfigurationError('model_credentials_backend_unavailable');
          default:
            throw new ConfigurationError(unavailable);
        }
      } finally {
        if (name) glib.g_free(name);
        glib.g_error_free(nativeError);
      }
    }

    const proxy = checked(
      (error) => secret.secret_service_get_sync(0, null, error),
      'model_credentials_backend_unavailable',
    );
    if (!proxy) throw new ConfigurationError('model_credentials_backend_unavailable');

    try {
      const connection = requirePointer(gio.g_dbus_proxy_get_connection(proxy));
      const owner = gio.g_dbus_proxy_get_name_owner(proxy);
      if (!owner) throw new ConfigurationError('model_credentials_backend_unavailable');

      try {
        // Every direct call targets the same unique service owner as the encrypted session.
        function call<T>(
          path: string,
          iface: string,
          method: string,
          args: Pointer | null,
          type: string,
          consume: (reply: Pointer) => T,
        ): T {
          const parameters = args ? requirePointer(glib.g_variant_ref_sink(args)) : null;
          let replyType: Pointer | undefined;
          let reply: Pointer | undefined;
          try {
            const expected = requirePointer(glib.g_variant_type_new(ptr(cString(type))));
            replyType = expected;
            reply = requirePointer(
              checked((error) =>
                gio.g_dbus_connection_call_sync(
                  connection,
                  owner,
                  ptr(cString(path)),
                  ptr(cString(iface)),
                  ptr(cString(method)),
                  parameters,
                  expected,
                  1, // G_DBUS_CALL_FLAGS_NO_AUTO_START
                  operationTimeoutMs,
                  null,
                  error,
                ),
              ),
            );
            return consume(reply);
          } finally {
            if (reply) glib.g_variant_unref(reply);
            if (replyType) glib.g_variant_type_free(replyType);
            if (parameters) glib.g_variant_unref(parameters);
          }
        }

        function child<T>(parent: Pointer, index: number, consume: (entry: Pointer) => T): T {
          const entry = requirePointer(glib.g_variant_get_child_value(parent, index));
          try {
            return consume(entry);
          } finally {
            glib.g_variant_unref(entry);
          }
        }

        const string = (value: string) =>
          requirePointer(glib.g_variant_new_string(ptr(cString(value))));
        const valueString = (value: Pointer) =>
          new CString(requirePointer(glib.g_variant_get_string(value, null)), 0, 4096).toString();
        const pathAt = (parent: Pointer, index: number) => child(parent, index, valueString);
        const pointers = (values: Pointer[]) => ptr(BigUint64Array.from(values.map(BigInt)));
        const tuple = (...values: Pointer[]) =>
          requirePointer(glib.g_variant_new_tuple(pointers(values), values.length));
        const dictionary = (entries: Record<string, Pointer>) => {
          const values = Object.entries(entries).map(([name, value]) =>
            requirePointer(glib.g_variant_new_dict_entry(string(name), value)),
          );
          return requirePointer(glib.g_variant_new_array(null, pointers(values), values.length));
        };
        const asVariant = (value: Pointer) => requirePointer(glib.g_variant_new_variant(value));
        // These attributes also match the pinned keyring-node Secret Service backend.
        const attributes = () =>
          dictionary({ service: string(input.service), username: string(input.account) });
        function search() {
          return call(
            servicePath,
            serviceInterface,
            'SearchItems',
            tuple(attributes()),
            '(aoao)',
            (reply) => {
              const unlocked = child(reply, 0, (entries) => {
                const count = glib.g_variant_n_children(entries);
                if (count > 1n) throw new ConfigurationError('credential_unavailable');
                return count ? pathAt(entries, 0) : null;
              });
              const locked = child(reply, 1, (entries) => glib.g_variant_n_children(entries));
              if (locked > 1n || (locked && unlocked))
                throw new ConfigurationError('credential_unavailable');
              if (locked) throw new ConfigurationError('model_credentials_locked');
              return unlocked;
            },
          );
        }

        function ensureEncryptedSession() {
          if (!checked((error) => secret.secret_service_ensure_session_sync(proxy, null, error)))
            throw new ConfigurationError('credential_unavailable');
          const algorithm = requirePointer(secret.secret_service_get_session_algorithms(proxy));
          if (new CString(algorithm, 0, 128).toString() !== 'dh-ietf1024-sha256-aes128-cbc-pkcs7')
            throw new ConfigurationError('model_credentials_backend_unavailable');
        }

        function read(path: string) {
          ensureEncryptedSession();
          const session = requirePointer(secret.secret_service_get_session_dbus_path(proxy));
          const argument = requirePointer(glib.g_variant_new_object_path(session));
          return call(path, itemInterface, 'GetSecret', tuple(argument), '((oayays))', (reply) =>
            child(reply, 0, (encoded) => {
              const value = requirePointer(
                secret.secret_service_decode_dbus_secret(proxy, encoded),
              );
              try {
                const size = new BigUint64Array(1);
                const data = requirePointer(secret.secret_value_get(value, ptr(size)));
                if (!size[0] || size[0] > BigInt(maxCredentialBytes))
                  throw new ConfigurationError('credential_unavailable');
                return Buffer.from(new Uint8Array(toArrayBuffer(data, 0, Number(size[0]))));
              } finally {
                secret.secret_value_unref(value);
              }
            }),
          );
        }

        function readAlias(alias: string) {
          return call(
            servicePath,
            serviceInterface,
            'ReadAlias',
            tuple(string(alias)),
            '(o)',
            (reply) => pathAt(reply, 0),
          );
        }

        function create(key: Buffer) {
          const collectionPath = readAlias('default');
          if (collectionPath === '/' || collectionPath === readAlias('session'))
            throw new ConfigurationError('model_credentials_backend_unavailable');
          const collection = requirePointer(
            checked((error) =>
              secret.secret_collection_new_for_dbus_path_sync(
                proxy,
                ptr(cString(collectionPath)),
                0,
                null,
                error,
              ),
            ),
          );
          try {
            if (secret.secret_collection_get_locked(collection))
              throw new ConfigurationError('model_credentials_locked');
          } finally {
            object.g_object_unref(collection);
          }

          ensureEncryptedSession();
          const value = requirePointer(
            secret.secret_value_new(ptr(key), key.length, ptr(cString('application/octet-stream'))),
          );
          try {
            const encoded = requirePointer(secret.secret_service_encode_dbus_secret(proxy, value));
            const properties = dictionary({
              [`${itemInterface}.Label`]: asVariant(string('Kite Code model credentials')),
              [`${itemInterface}.Attributes`]: asVariant(attributes()),
            });
            const replace = requirePointer(glib.g_variant_new_boolean(false));
            const created = call(
              collectionPath,
              collectionInterface,
              'CreateItem',
              tuple(properties, encoded, replace),
              '(oo)',
              (reply) => {
                if (pathAt(reply, 1) !== '/')
                  throw new ConfigurationError('model_credentials_locked');
                return pathAt(reply, 0);
              },
            );
            // The vault serializes its first writer. Refuse duplicate or unstable results anyway.
            if (created === '/' || search() !== created)
              throw new ConfigurationError('credential_unavailable');
            const saved = read(created);
            try {
              if (!key.equals(saved)) throw new ConfigurationError('credential_unavailable');
            } finally {
              saved.fill(0);
            }
          } finally {
            secret.secret_value_unref(value);
          }
        }

        const path = search();
        if (input.operation === 'read') return path ? read(path) : null;
        if (input.operation === 'create') {
          if (path) throw new ConfigurationError('credential_already_exists');
          if (input.key?.length !== 32) throw new ConfigurationError('credential_unavailable');
          create(input.key);
        } else if (path) {
          call(path, itemInterface, 'Delete', null, '(o)', (reply) => {
            if (pathAt(reply, 0) !== '/') throw new ConfigurationError('model_credentials_locked');
          });
          if (search()) throw new ConfigurationError('credential_unavailable');
        }
        return null;
      } finally {
        glib.g_free(owner);
      }
    } finally {
      object.g_object_unref(proxy);
    }
  } finally {
    for (const library of libraries.reverse()) library.close();
  }
}
