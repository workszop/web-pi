import { Lfm3ForCausalLM } from '../runtime/Lfm3ForCausalLM.js';
import { WorkspaceController } from './controller.js';
import { Lfm3VlModel } from './vl-model.js';
import { createStore, createWorkspace } from './workspace.js';

const emit = message => postMessage(message);
const initialized = (async () => {
  let store, saved;
  try { store = await createStore(); saved = await store.load(); }
  catch (error) { emit({ type: 'persistence_error', error: `Workspace saving is unavailable: ${error.message}` }); }
  const workspace = createWorkspace(saved?.files, saved?.entries);
  await workspace.ready;
  const controller = new WorkspaceController({ Model: Lfm3ForCausalLM, VisionModel: Lfm3VlModel, workspace, store, saved, emit });
  emit({ type: 'initialized', ...(await controller.uiSnapshot()) });
  return controller;
})();

// Attach a rejection handler immediately, including failures before the first RPC.
initialized.catch(error => emit({ type: 'fatal', stage: 'initialization', error: `Workspace initialization failed: ${error.message}. Reload the page to retry.` }));

self.onmessage = async ({ data: { id, action, args = {} } }) => {
  try {
    const controller = await initialized;
    const value = await controller.dispatch(action, args);
    emit({ type: 'reply', id, value });
  } catch (error) {
    emit({ type: 'reply', id, error: error.name === 'AbortError' ? 'Stopped.' : String(error.message ?? error), errorName: error.name, errorCode: error.code });
  }
};
