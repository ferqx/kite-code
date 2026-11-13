import { nativeRuntime } from './runtime-native';

export type Pointer = number & { readonly __nativePointer: unique symbol };
type Scalar = 'bool' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'ptr';
type Return = Scalar | 'void';
type Signature = { readonly args?: readonly Scalar[]; readonly returns?: Return };
type Input<T> = T extends 'ptr'
  ? number | bigint | null
  : T extends 'i64' | 'u64'
    ? number | bigint
    : T extends 'bool'
      ? boolean | number
      : number;
type Output<T> = T extends 'ptr'
  ? Pointer | null
  : T extends 'i64' | 'u64'
    ? bigint
    : T extends 'bool'
      ? boolean
      : T extends 'void' | undefined
        ? undefined
        : number;
type Inputs<T extends readonly Scalar[]> = { -readonly [K in keyof T]: Input<T[K]> };
type NativeSymbols<S extends Record<string, Signature>> = {
  [K in keyof S]: (
    ...args: S[K]['args'] extends readonly Scalar[] ? Inputs<S[K]['args']> : []
  ) => Output<S[K]['returns']>;
};

// Imports are inert. The addon and system libraries load only at the operation boundary.
export function dlopen<const S extends Record<string, Signature>>(path: string, symbols: S) {
  const native = nativeRuntime();
  const library = native.ffiOpen(path);
  try {
    const entries = Object.entries(symbols).map(([name, signature]) => [
      name,
      native.ffiBind(library, name, signature.args ?? [], signature.returns ?? 'void'),
    ]);
    return {
      symbols: Object.fromEntries(entries) as NativeSymbols<S>,
      close: () => native.ffiClose(library),
    };
  } catch (error) {
    native.ffiClose(library);
    throw error;
  }
}

export function ptr(value: ArrayBufferLike | ArrayBufferView, offset = 0): Pointer {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.byteLength)
    throw Error('native_runtime_pointer_invalid');
  return (nativeRuntime().ffiPtr(
    value instanceof SharedArrayBuffer ? new Uint8Array(value) : value,
  ) + offset) as Pointer;
}

export function toArrayBuffer(
  address: number | bigint,
  offset: number,
  length: number,
): ArrayBuffer {
  return nativeRuntime().ffiView(address, offset, length);
}

export class CString {
  private readonly value: string;
  constructor(address: number | bigint, offset = 0, maxLength = 1024) {
    this.value = nativeRuntime().ffiCString(address, offset, maxLength);
  }
  toString(): string {
    return this.value;
  }
}
