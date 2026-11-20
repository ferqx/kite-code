type Row = Record<string, unknown>;
const row = (v: unknown): Row | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined;
const validId = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,256}$/.test(v);
const empty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);
const only = (v: Row, fields: readonly string[]) =>
  Object.keys(v).every((key) => fields.includes(key));
const messageFields = ['id', 'type', 'status', 'role', 'content', 'phase'];
const reasoningFields = ['id', 'type', 'status', 'summary', 'content', 'encrypted_content'];

function outputText(v: unknown) {
  const p = row(v);
  return p?.type === 'output_text' &&
    typeof p.text === 'string' &&
    empty(p.annotations) &&
    (p.logprobs == null || empty(p.logprobs)) &&
    only(p, ['type', 'text', 'annotations', 'logprobs'])
    ? p.text
    : undefined;
}

type Slot = {
  id: string;
  type: 'reasoning' | 'message';
  closed: boolean;
  status?: 'completed' | 'incomplete';
  encrypted?: string;
  phase?: 'commentary' | 'final_answer';
};

/** Recognize only empty-summary reasoning followed by one assistant output_text block.
 * Other legitimate stream shapes keep the existing ambiguous-length handling. */
export class PlainLengthProof {
  private eligible = true;
  private terminal = false;
  private responseId?: string;
  private model?: string;
  private slots: Slot[] = [];
  private text = '';
  private partAdded = false;
  private textDone = false;
  private partDone = false;

  reject() {
    if (!this.eligible) return;
    this.eligible = false;
    this.slots = [];
    this.text = '';
  }
  matches(displayed: string | undefined, continuation: unknown) {
    if (!this.eligible || !this.terminal || this.text !== displayed) return false;
    const parts = row(continuation)?.content;
    const sealed = this.slots.filter((slot) => slot.encrypted !== undefined);
    if (parts === undefined) return !sealed.length;
    if (!Array.isArray(parts) || parts.length > this.slots.length) return false;
    const seen = new Set<string>();
    for (const raw of parts) {
      const part = row(raw);
      const metadata = row(row(part?.providerOptions)?.openai);
      const slot = this.slots.find((s) => s.id === metadata?.itemId);
      if (!part || !slot || seen.has(slot.id)) return false;
      if (slot.type === 'reasoning') {
        if (
          part.type !== 'reasoning' ||
          part.text !== '' ||
          (metadata?.reasoningEncryptedContent ?? undefined) !== slot.encrypted
        )
          return false;
      } else if (part.type !== 'text' || part.text !== this.text) return false;
      seen.add(slot.id);
    }
    return seen.has(this.slots.at(-1)!.id) && sealed.every((slot) => seen.has(slot.id));
  }
  private matchesItem(raw: Row, slot: Slot, stage: 'added' | 'done' | 'terminal') {
    if (raw.type !== slot.type || raw.id !== slot.id) return false;
    if (raw.status !== undefined && !(stage === 'added' && raw.status === 'in_progress')) {
      if (
        (raw.status !== 'completed' && raw.status !== 'incomplete') ||
        (slot.status !== undefined && slot.status !== raw.status)
      )
        return false;
      slot.status = raw.status;
    }
    if (slot.type === 'reasoning') {
      if (
        !only(raw, reasoningFields) ||
        !empty(raw.content) ||
        !empty(raw.summary) ||
        (stage === 'terminal' && !Array.isArray(raw.summary))
      )
        return false;
      if (raw.encrypted_content != null) {
        if (
          typeof raw.encrypted_content !== 'string' ||
          raw.encrypted_content.length > 16384 ||
          (slot.encrypted !== undefined && slot.encrypted !== raw.encrypted_content)
        )
          return false;
        slot.encrypted = raw.encrypted_content;
      }
      return (
        stage !== 'terminal' ||
        raw.encrypted_content === slot.encrypted ||
        (raw.encrypted_content == null && slot.encrypted === undefined)
      );
    }
    if (!only(raw, messageFields) || (raw.role !== undefined && raw.role !== 'assistant'))
      return false;
    if (raw.phase != null) {
      if (
        (raw.phase !== 'commentary' && raw.phase !== 'final_answer') ||
        (slot.phase && slot.phase !== raw.phase)
      )
        return false;
      slot.phase = raw.phase;
    }
    if (stage === 'added') return empty(raw.content);
    if (
      stage === 'terminal' &&
      (raw.role !== 'assistant' || !slot.status || raw.status !== slot.status)
    )
      return false;
    return (
      Array.isArray(raw.content) &&
      raw.content.length === 1 &&
      outputText(raw.content[0]) === this.text
    );
  }
  observe(value: unknown) {
    if (!this.eligible) return;
    const f = row(value);
    if (!f || this.terminal) return this.reject();
    const response = row(f.response);
    if (f.type === 'response.created' || f.type === 'response.in_progress') {
      if (
        !response ||
        this.slots.length ||
        !validId(response.id) ||
        response.error != null ||
        response.incomplete_details != null ||
        !empty(response.output) ||
        (response.status !== undefined &&
          response.status !== 'in_progress' &&
          response.status !== 'queued') ||
        (f.type === 'response.created'
          ? this.responseId !== undefined
          : this.responseId !== response.id)
      )
        return this.reject();
      if (response.model !== undefined) {
        if (!validId(response.model) || (this.model && this.model !== response.model))
          return this.reject();
        this.model = response.model;
      }
      this.responseId = response.id;
      return;
    }
    if (!this.responseId) return this.reject();
    const last = this.slots.at(-1);
    if (f.type === 'response.incomplete') {
      const usage = row(response?.usage);
      if (
        !usage ||
        ![usage.input_tokens, usage.output_tokens].every(
          (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
        )
      )
        return this.reject();
      if (
        !response ||
        response.id !== this.responseId ||
        response.status !== 'incomplete' ||
        response.error != null ||
        (response.model !== undefined && response.model !== this.model) ||
        row(response.incomplete_details)?.reason !== 'max_output_tokens' ||
        !this.text.trim() ||
        last?.type !== 'message' ||
        !Array.isArray(response.output) ||
        response.output.length !== this.slots.length
      )
        return this.reject();
      for (const [i, raw] of response.output.entries()) {
        const item = row(raw);
        if (!item || !this.matchesItem(item, this.slots[i]!, 'terminal')) return this.reject();
      }
      this.terminal = true;
      return;
    }
    if (f.type === 'response.output_item.added') {
      const item = row(f.item);
      if (
        !item ||
        f.output_index !== this.slots.length ||
        this.slots.length >= 16 ||
        (last && (!last.closed || last.type === 'message')) ||
        !validId(item.id) ||
        this.slots.some((s) => s.id === item.id) ||
        (item.type !== 'reasoning' && item.type !== 'message')
      )
        return this.reject();
      const slot: Slot = { id: item.id, type: item.type, closed: false };
      if (!this.matchesItem(item, slot, 'added')) return this.reject();
      this.slots.push(slot);
      return;
    }
    if (!last || last.closed || f.output_index !== this.slots.length - 1) return this.reject();
    if (f.type === 'response.output_item.done') {
      const item = row(f.item);
      if (!item || !this.matchesItem(item, last, 'done')) return this.reject();
      last.closed = true;
      return;
    }
    if (last.type !== 'message' || last.id !== f.item_id || f.content_index !== 0 || this.partDone)
      return this.reject();
    if (f.logprobs != null && !empty(f.logprobs)) return this.reject();
    switch (f.type) {
      case 'response.content_part.added':
        if (this.partAdded || this.text || this.textDone || outputText(f.part) !== '')
          return this.reject();
        this.partAdded = true;
        break;
      case 'response.output_text.delta':
        if (
          this.textDone ||
          typeof f.delta !== 'string' ||
          this.text.length + f.delta.length > 262144
        )
          return this.reject();
        this.text += f.delta;
        break;
      case 'response.output_text.done':
        if (this.textDone || f.text !== this.text) return this.reject();
        this.textDone = true;
        break;
      case 'response.content_part.done':
        if (outputText(f.part) !== this.text) return this.reject();
        this.partDone = true;
        break;
      default:
        this.reject();
    }
  }
}
