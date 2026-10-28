// LFM3-VL-2B (ONNX, 4-bit weights) through transformers.js on WebGPU, shaped like the supplied
// GGUF model so the same Agent and controller drive it:
//   static checkAvailability(), static from_pretrained(id, { onProgress, maxLength })
//   generate(messages, { tools, max_new_tokens, signal }) -> async iterable of
//     { type: 'text' | 'reasoning', text } events, with .result -> { message, finish_reason, usage, timings }
//   contextLength, dispose(); resolveImages(text) is set by the controller.

import { CONTEXT_LENGTH, MAX_IMAGES_PER_MESSAGE, TRANSFORMERS_URL, VL_DTYPE, VL_MODEL_ID } from './config.js';

// ─── Constants ───
const THINK_END = '</think>';
const CALL_START = '<tool_call>';
const CALL_PATTERN = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const PARAM_PATTERN = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
const REPETITION_PENALTY = 1.05;

// ─── State ───
let library = null;

// ─── Helpers ───
const loadLibrary = () => (library ??= import(TRANSFORMERS_URL).then(T => {
  T.env.allowLocalModels = false;
  return T;
}));

// Async iterable of events plus a .result promise, like the runtime's generation handle.
class EventStream {
  #queue = [];
  #wake = null;
  #done = false;
  push(event) { this.#queue.push(event); this.#wake?.(); }
  end() { this.#done = true; this.#wake?.(); }
  [Symbol.asyncIterator]() { return this; }
  async next() {
    for (;;) {
      if (this.#queue.length) return { value: this.#queue.shift(), done: false };
      if (this.#done) return { value: undefined, done: true };
      await new Promise(resolve => { this.#wake = resolve; });
      this.#wake = null;
    }
  }
  async return() { this.#done = true; return { value: undefined, done: true }; }
}

// Routes streamed text: reasoning until </think>, then answer text, and holds back tool-call markup.
export class Splitter {
  constructor(stream) { this.stream = stream; this.mode = 'reasoning'; this.pending = ''; this.full = ''; }
  push(chunk) {
    this.full += chunk;
    this.pending += chunk;
    for (;;) {
      if (this.mode === 'call') { this.pending = ''; return; }
      const tag = this.mode === 'reasoning' ? THINK_END : CALL_START;
      const at = this.pending.indexOf(tag);
      if (at >= 0) {
        this.emit(this.pending.slice(0, at));
        this.pending = this.pending.slice(at + tag.length);
        this.mode = this.mode === 'reasoning' ? 'text' : 'call';
        continue;
      }
      const safe = this.pending.length - (tag.length - 1);   // a tag may be split across chunks
      if (safe > 0) { this.emit(this.pending.slice(0, safe)); this.pending = this.pending.slice(safe); }
      return;
    }
  }
  flush() { if (this.mode !== 'call') this.emit(this.pending); this.pending = ''; }
  emit(text) { if (text) this.stream.push({ type: this.mode === 'reasoning' ? 'reasoning' : 'text', text }); }
}

export function parseToolCalls(text, tools = []) {
  const schemas = new Map(tools.map(tool => [tool.function.name, tool.function.parameters?.properties ?? {}]));
  const calls = [];
  const content = text.replace(CALL_PATTERN, (_, name, body) => {
    const properties = schemas.get(name) ?? {};
    const args = {};
    for (const [, key, raw] of body.matchAll(PARAM_PATTERN)) {
      if (properties[key]?.type && properties[key].type !== 'string') {
        try { args[key] = JSON.parse(raw); continue; } catch { /* keep the raw text */ }
      }
      args[key] = raw;
    }
    calls.push({ id: `call_${Date.now().toString(36)}_${calls.length}`, type: 'function', function: { name, arguments: args } });
    return '';
  });
  const errors = content.includes(CALL_START) ? ['The tool call was cut off before it closed.'] : [];
  return { content: content.replace(/<tool_call>[\s\S]*$/, '').trim(), calls, errors };
}

function contextError(required, capacity) {
  const error = new Error(`The conversation needs ${required} tokens; the model has room for ${capacity}.`);
  return Object.assign(error, { name: 'ContextOverflowError', required, capacity });
}

// ─── Model ───
export class Lfm3VlModel {
  #T; #processor; #model; #images = new WeakMap(); #busy = false;
  resolveImages = async () => [];

  constructor(T, processor, model, maxLength) {
    this.#T = T;
    this.#processor = processor;
    this.#model = model;
    this.contextLength = Math.min(maxLength ?? CONTEXT_LENGTH, CONTEXT_LENGTH);
  }

  static async checkAvailability() {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return { ok: false, reason: 'WebGPU is not available in this browser.' };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  static async from_pretrained(id = VL_MODEL_ID, { onProgress, maxLength } = {}) {
    const T = await loadLibrary();
    // Report bytes in the runtime's shape so conversation.loadProgress() treats it as a download.
    const progress_callback = info => {
      if (info.status === 'progress_total' && info.total > 0) onProgress?.({ status: 'weights', kind: 'bytes', loaded: info.loaded, total: info.total });
    };
    const [processor, model] = await Promise.all([
      T.AutoProcessor.from_pretrained(id),
      T.AutoModelForImageTextToText.from_pretrained(id, { device: 'webgpu', dtype: VL_DTYPE, progress_callback }),
    ]);
    onProgress?.({ status: 'compile', message: 'Preparing LFM3-VL-2B…' });
    return new Lfm3VlModel(T, processor, model, maxLength);
  }

  generate(messages, options = {}) {
    const stream = new EventStream();
    stream.result = this.#run(messages, options, stream).finally(() => stream.end());
    stream.result.catch(() => {});
    return stream;
  }

  async #imagesFor(message) {
    if (!this.#images.has(message)) {
      this.#images.set(message, (async () => {
        const refs = (await this.resolveImages(message.content)).slice(0, MAX_IMAGES_PER_MESSAGE);
        return Promise.all(refs.map(ref => this.#T.RawImage.fromBlob(new Blob([ref.bytes], { type: ref.type }))));
      })());
    }
    return this.#images.get(message);
  }

  async #run(messages, { tools, max_new_tokens = 1024, signal } = {}, stream) {
    if (this.#busy) throw new Error('LFM3-VL-2B is already generating.');
    this.#busy = true;
    try {
      const T = this.#T, processor = this.#processor;
      const chat = [], images = [];
      for (const message of messages) {
        if (message.role === 'user' && typeof message.content === 'string') {
          const found = await this.#imagesFor(message);
          if (found.length) {
            chat.push({ ...message, content: [...found.map(() => ({ type: 'image' })), { type: 'text', text: message.content }] });
            images.push(...found);
            continue;
          }
        }
        chat.push(message);
      }
      const prompt = processor.apply_chat_template(chat, { add_generation_prompt: true, ...(tools?.length ? { tools } : {}) });
      const inputs = await processor(images.length ? images : null, prompt, { add_special_tokens: false });
      const promptTokens = inputs.input_ids.dims.at(-1);
      if (promptTokens >= this.contextLength) throw contextError(promptTokens + 1, this.contextLength);
      const budget = Math.min(max_new_tokens, this.contextLength - promptTokens);

      const stopping = new T.InterruptableStoppingCriteria();
      const onAbort = () => stopping.interrupt();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) stopping.interrupt();

      const splitter = new Splitter(stream);
      let tokens = 0, firstAt = 0;
      const startedAt = performance.now();
      const streamer = new T.TextStreamer(processor.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: text => splitter.push(text),
        token_callback_function: () => { if (tokens++ === 0) firstAt = performance.now(); },
      });
      try {
        await this.#model.generate({
          ...inputs, do_sample: false, repetition_penalty: REPETITION_PENALTY,
          max_new_tokens: budget, streamer, stopping_criteria: stopping,
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      splitter.flush();
      const endedAt = performance.now();

      const thinkEnd = splitter.full.indexOf(THINK_END);
      const reasoning = (thinkEnd >= 0 ? splitter.full.slice(0, thinkEnd) : splitter.full).trim();
      const answer = thinkEnd >= 0 ? splitter.full.slice(thinkEnd + THINK_END.length) : '';
      const { content, calls, errors } = parseToolCalls(answer, tools);
      if (errors.length && calls.length) calls.at(-1).errors = errors;

      const cancelled = stopping.interrupted || signal?.aborted;
      const finish_reason = cancelled ? 'cancelled' : calls.length ? 'tool_calls' : tokens >= budget ? 'length' : 'stop';
      const decodeMs = firstAt ? endedAt - firstAt : 0;
      return {
        message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason,
        ...(finish_reason === 'length' ? { limit: budget < max_new_tokens ? 'context' : 'tokens' } : {}),
        usage: { prompt_tokens: promptTokens, cached_tokens: 0, image_tokens: 0, completion_tokens: tokens, reasoning_tokens: 0 },
        timings: { ttft_ms: firstAt ? firstAt - startedAt : 0, decode_ms: decodeMs, tokens_per_second: tokens > 1 && decodeMs > 0 ? (tokens - 1) / (decodeMs / 1000) : 0 },
      };
    } finally {
      this.#busy = false;
    }
  }

  async dispose() { await this.#model?.dispose?.(); this.#model = null; }
}
