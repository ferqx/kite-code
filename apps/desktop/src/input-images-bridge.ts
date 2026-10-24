export const inputImageCount = 10;
export const inputImageWindowCount = 128;

export type NativeInputImageRequest =
  | {
      method: 'input.files.begin';
      generation: number;
      id: string;
      name: string;
      mediaType: string;
      size: number;
    }
  | {
      method: 'input.files.append';
      generation: number;
      id: string;
      offset: number;
      data: Uint8Array;
    }
  | { method: 'input.files.finish' | 'input.files.release'; generation: number; id: string }
  | {
      method: 'input.images.begin';
      generation: number;
      id: string;
      name: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      size: number;
      hash: string;
    }
  | { method: 'input.images.append'; generation: number; id: string; offset: number; data: string }
  | { method: 'input.images.finish' | 'input.images.release'; generation: number; id: string }
  | {
      method: 'input.image.open';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageId: string;
      index: number;
    }
  | { method: 'input.image.read'; generation: number; readId: string; offset: number }
  | { method: 'input.image.close'; generation: number; readId: string };
export type NativeInputFileResult =
  | { kind: 'input.image.open'; readId: string; size: number; hash: string; mediaType: string }
  | {
      kind: 'input.image.chunk';
      readId: string;
      offset: number;
      nextOffset: number;
      data: string;
      done: boolean;
    };
