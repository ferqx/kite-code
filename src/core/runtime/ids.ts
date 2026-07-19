// src/core/runtime/ids.ts
// 共享的 ID 生成函数，供 runtime 模块复用
//
// interactionId: 4-byte random → 8 hex chars (int_ prefix)
// turnId:       4-byte random → 8 hex chars (turn_ prefix)

/** 4-byte 随机 hex，带 "int_" 前缀（interaction 标识） */
export function genInteractionId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return `int_${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 4-byte 随机 hex，带 "turn_" 前缀（turn 标识） */
export function genTurnId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return `turn_${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
