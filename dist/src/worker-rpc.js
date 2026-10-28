// Direct RPC to the app's agent worker (captured by src/worker-hook.js). The bundle ignores replies
// to ids it did not send, so sibling modules can use the same worker for their own actions.

let seq = 0;

export function rpc(action, args) {
  const worker = window.__appWorkers?.find(w => /agent\.worker\.js/.test(w.scriptUrl));
  if (!worker) return Promise.reject(new Error('The workspace is not ready yet.'));
  const id = `ext-${++seq}`;
  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data?.type !== 'reply' || data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      data.error ? reject(new Error(data.error)) : resolve(data.value);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, action, args });
  });
}
