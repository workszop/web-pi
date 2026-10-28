import { Agent } from '../runtime/agent.js';
import { CONTEXT_LENGTH, INSTRUCTIONS, MAX_NEW_TOKENS, MAX_ROUNDS, MODEL_FILE, MODEL_FILES, MODEL_ID, Q4KM_FILE, VL_CHOICE, VL_INSTRUCTIONS, VL_MODEL_ID } from './config.js';
import { appendDelta, assistantMessage, loadProgress, timestamp, toolMessage } from './conversation.js';

export class WorkspaceController {
  constructor({ Model, VisionModel, workspace, store, saved, emit, AgentClass = Agent }) {
    Object.assign(this, { Model, VisionModel, workspace, store, emit, AgentClass });
    this.history = saved?.messages ?? [];
    this.display = saved?.displayMessages ?? [];
    this.model = null;
    this.agent = null;
    this.busy = false;
    this.operation = null;
    this.run = null;
    this.deviceLoss = null;
    this.modelFile = MODEL_FILES.includes(saved?.modelFile) ? saved.modelFile : MODEL_FILE;
  }

  async snapshot() {
    return {
      version: 2, runtime: 'lfm3-gguf', modelId: MODEL_ID, modelFile: this.modelFile,
      files: await this.workspace.snapshot(), entries: await this.workspace.serialize(),
      messages: this.agent?.messages.filter(message => message.role !== 'system') ?? this.history,
      displayMessages: this.display,
    };
  }

  // The frontend receives Pi display messages; persistence keeps canonical runtime messages too.
  async uiSnapshot() {
    return { ...(await this.snapshot()), messages: this.display };
  }

  async save() {
    const snapshot = await this.snapshot();
    this.history = snapshot.messages;
    try { await this.store?.save(snapshot); }
    catch (error) { this.emit({ type: 'persistence_error', error: `Changes are in memory, but saving failed: ${error.message}` }); }
    this.emit({ type: 'workspace', files: snapshot.files });
  }

  event(event) { this.emit({ type: 'agent_event', event }); }

  async load({ file = this.modelFile } = {}, signal) {
    if (!MODEL_FILES.includes(file)) throw new Error('Choose LFM3-1.7B QAD Q4_0, LFM3-1.7B Q4_K_M, or LFM3-VL-2B.');
    if (this.model && file !== this.modelFile) throw new Error('Reload the page before choosing a different model.');
    const vision = file === VL_CHOICE;
    if (vision && !this.VisionModel) throw new Error('The vision model is not available in this build.');
    const Model = vision ? this.VisionModel : this.Model;
    const modelId = vision ? VL_MODEL_ID : MODEL_ID;
    if (this.model) return true;
    // Omit file for Q4_K_M: the supplied library owns that repository default (the app default is QAD).
    const selection = file === Q4KM_FILE || vision ? {} : { file };
    const support = await Model.checkAvailability(modelId, { ...selection, signal });
    signal.throwIfAborted();
    if (!support.ok) throw new Error(support.reason || 'This GPU cannot run the model.');
    let model;
    try {
      model = await Model.from_pretrained(modelId, {
        ...selection, maxLength: CONTEXT_LENGTH, signal,
        onProgress: progress => this.emit(loadProgress(progress)),
      });
      signal.throwIfAborted();
      if (vision) model.resolveImages = text => this.workspace.imagesIn(text);
      this.model = model;
      this.agent = new this.AgentClass({
        model, instructions: vision ? VL_INSTRUCTIONS : INSTRUCTIONS, tools: this.workspace.tools, messages: this.history,
        max_new_tokens: MAX_NEW_TOKENS, max_rounds: MAX_ROUNDS,
        do_sample: false,
      });
      // Reset and reload share one agent/session; Agent owns its session, not the model.
      const lostModel = model;
      model.lost?.then(async info => {
        if (this.model !== lostModel) return;
        // On integrated GPUs a long prefill can outrun the driver's job timeout (see README, Intel integrated GPUs).
        this.deviceLoss = new Error(`GPU device lost${info?.message ? ': ' + info.message : '.'} Load the model again to continue. If it happens again on a long chat, start a new chat: integrated GPUs can time out while reading long prompts.`);
        this.operation?.abort(this.deviceLoss);
        this.run?.cancel();
        this.emit({ type: 'fatal', error: this.deviceLoss.message });
        // Cleanup waits for generation and any tool to settle before releasing buffers.
        const oldAgent = this.agent;
        this.model = null;
        this.agent = null;
        await oldAgent?.dispose();
        await lostModel.dispose();
      }).catch(error => this.emit({ type: 'notice', text: `GPU cleanup: ${error.message}` }));
      this.deviceLoss = null;
      this.modelFile = file;
      this.emit({ type: 'loaded', contextLength: model.contextLength, modelFile: file });
      await this.save();
      return true;
    } catch (error) {
      if (this.model === model) { this.model = null; this.agent = null; }
      await model?.dispose();
      throw error;
    }
  }

  async prompt(text, signal) {
    if (!this.agent) throw new Error('Load the model first.');
    const agent = this.agent;
    const user = { role: 'user', content: text, timestamp: timestamp() };
    this.display.push(user);
    this.event({ type: 'agent_start' });
    this.event({ type: 'message_end', message: user });
    let partial;
    let lastPaint = 0;
    let run;
    try {
      run = this.run = agent.run(text, { signal });
      for await (const event of run) {
        if (event.type === 'turn_start') {
          partial = assistantMessage();
          this.display.push(partial);
          this.event({ type: 'turn_start' });
          this.event({ type: 'message_start', message: partial });
          this.emit({ type: 'inference_activity', phase: 'prefill' });
        } else if (event.type === 'prefill') {
          this.emit({ type: 'inference_activity', phase: 'prefill', done: event.done, total: event.total });
        } else if (event.type === 'text' || event.type === 'reasoning') {
          const key = appendDelta(partial, event.type, event.text);
          // Delta events carry text, not token counts. Show activity live; exact token
          // speed comes from the runtime's timings when the turn completes.
          const now = performance.now();
          if (now - lastPaint >= 60) {
            this.event({ type: 'message_update', message: partial, assistantMessageEvent: { type: `${key}_delta`, delta: event.text, partial } });
            this.emit({ type: 'inference_activity', phase: 'decode', rate: null });
            lastPaint = now;
          }
        } else if (event.type === 'turn_end') {
          const { result } = event;
          const complete = assistantMessage(result.message, result, partial.timestamp);
          this.display[this.display.indexOf(partial)] = complete;
          partial = complete;
          this.event({ type: 'message_end', message: complete });
          this.event({ type: 'turn_end', message: complete, toolResults: [] });
          this.emit({ type: 'context_usage', inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens });
          if (result.timings?.tokens_per_second > 0) this.emit({ type: 'inference_activity', phase: 'decode', rate: result.timings.tokens_per_second });
          await this.save();
        } else if (event.type === 'tool_start') {
          this.event({ type: 'tool_execution_start', toolCallId: event.call.id,
            toolName: event.call.function.name, args: event.call.function.arguments });
        } else if (event.type === 'tool_end') {
          const message = toolMessage(event);
          this.display.push(message);
          this.event({ type: 'message_end', message });
          this.event({ type: 'tool_execution_end', toolCallId: event.call.id, toolName: event.call.function.name,
            result: { content: message.content, details: event.details }, isError: event.is_error });
          await this.save();
        }
      }
      const result = await run.result;
      if (result.finish_reason === 'max_rounds') this.emit({ type: 'notice', text: `Paused after ${MAX_ROUNDS} agent turns. Send a follow-up to continue.` });
      if (result.finish_reason === 'length') this.emit({ type: 'notice', text: result.limit === 'context'
        ? 'The model context is full. Start a new chat or shorten the conversation.'
        : 'The reply reached its token limit. Send a follow-up to continue.' });
      if (result.finish_reason === 'cancelled') this.emit({ type: 'notice', text: 'Stopped. The interrupted reply is shown here; it is omitted from the model history.' });
    } catch (error) {
      // Iteration and run.result reject with the same error. Keep completed history,
      // end the visible partial reply, and surface the failure through the RPC.
      await run?.result.catch(() => {});
      if (partial && !partial.stopReason) {
        partial.stopReason = signal.aborted ? 'aborted' : 'error';
        partial.errorMessage = error.message;
        this.event({ type: 'message_end', message: partial });
      }
      if (error.name === 'ContextOverflowError') {
        this.emit({ type: 'notice', text: `The conversation needs ${error.required} tokens; this GPU has room for ${error.capacity}. Start a new chat or shorten the conversation.` });
      }
      throw error;
    } finally {
      this.run = null;
      // Capture from the local agent even if device-loss cleanup detached it.
      this.history = agent.messages.filter(message => message.role !== 'system');
      await this.save();
      this.emit({ type: 'inference_activity', phase: 'end' });
      this.event({ type: 'agent_end', messages: this.display });
    }
    return this.uiSnapshot();
  }

  async dispatch(action, args = {}) {
    if (action === 'stop') { this.operation?.abort(new DOMException('Stopped.', 'AbortError')); this.run?.cancel(); return true; }
    if (action === 'snapshot') {
      // Export native messages alongside display messages so exports are restorable.
      if (this.busy) throw new Error('Wait for the current operation or stop it before exporting.');
      return this.snapshot();
    }
    if (this.busy) throw new Error('Wait for the current operation or stop it first.');
    this.busy = true;
    this.operation = new AbortController();
    this.emit({ type: 'busy', action });
    try {
      const signal = this.operation.signal;
      if (action === 'load') return await this.load(args, signal);
      if (action === 'prompt') return await this.prompt(args.text, signal);
      if (action === 'shell') {
        const result = await this.workspace.bash.exec(args.command, { signal });
        await this.save();
        return result;
      }
      if (action === 'write') { await this.workspace.write(args.path, args.content); await this.save(); return this.uiSnapshot(); }
      if (action === 'write_bytes') { await this.workspace.writeBytes(args.path, args.bytes); await this.save(); return true; }
      if (action === 'read') return await this.workspace.read(args.path);
      if (action === 'new_chat') {
        this.agent?.reset();
        this.history = [];
        this.display = [];
        await this.save();
        return this.uiSnapshot();
      }
      throw new Error(`Unknown action: ${action}`);
    } finally {
      this.busy = false;
      this.operation = null;
      this.emit({ type: 'idle' });
    }
  }

  async dispose() {
    this.operation?.abort();
    await this.agent?.dispose();
    const model = this.model;
    this.model = null;
    this.agent = null;
    await model?.dispose();
  }
}
