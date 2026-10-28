// Adapt Agent events to the Pi terminal's display format.
// Native messages stay untouched in Agent.messages; these are display objects only.
let lastTimestamp = 0;
export function timestamp() {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
}

export function piUsage(usage = {}) {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    input, output, cacheRead: usage.cached_tokens ?? 0, cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function assistantMessage(native = {}, result = {}, at = timestamp()) {
  const content = [];
  if (native.reasoning_content) content.push({ type: 'thinking', thinking: native.reasoning_content });
  if (native.content) content.push({ type: 'text', text: native.content });
  for (const call of native.tool_calls ?? []) {
    content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const reasons = { stop: 'stop', length: 'length', tool_calls: 'toolUse', cancelled: 'aborted' };
  return {
    role: 'assistant', content, timestamp: at, api: 'webgpu', provider: 'local', model: 'LFM3-1.7B-GGUF',
    usage: piUsage(result.usage),
    ...(result.finish_reason ? { stopReason: reasons[result.finish_reason] ?? 'error' } : {}),
  };
}

export function toolMessage(event) {
  return {
    role: 'toolResult', toolCallId: event.call.id, toolName: event.call.function.name,
    content: [{ type: 'text', text: event.message.content ?? '' }],
    details: event.details, isError: event.is_error, timestamp: timestamp(),
  };
}

export function appendDelta(message, type, text) {
  const key = type === 'reasoning' ? 'thinking' : 'text';
  let block = message.content.find(block => block.type === key);
  if (!block) message.content.push(block = { type: key, [key]: '' });
  block[key] += text;
  return key;
}

export function loadProgress(progress) {
  // Tensor counts are not bytes, even though both have loaded/total fields.
  if (progress.status === 'weights' && progress.kind === 'bytes' && progress.total > 0) {
    return { type: 'load_progress', phase: 'download', loaded: progress.loaded, total: progress.total };
  }
  return { type: 'load_progress', phase: 'compile', status: progress.status, message: progress.message };
}
