import { Bash } from '../vendor/just-bash.js';

export const WORKSPACE_DB_NAME = 'lfm3-gguf-workspace';
export const WORKSPACE_ROOT = '/workspace';
export const MAX_EDITOR_BYTES = 1024 * 1024;
export const EXECUTION_LIMITS = Object.freeze({
  maxExecutionTimeMs: 10_000,
  maxCommandCount: 3_000,
  maxFileSystemBytes: 16 * 1024 * 1024,
  maxOutputSize: 262_144,
  maxSourceBytes: 131_072,
});

export const DEFAULT_FILES = Object.freeze({
  '/workspace/README.md': '# Browser workspace\n\nYour files are saved in this browser.\n',
  '/workspace/sales.csv': 'product,units\nNotebook,12\nPencil,30\nFolder,8\n',
  '/workspace/products.json': JSON.stringify([
    { product: 'Notebook', price: 5 },
    { product: 'Pencil', price: 2 },
    { product: 'Folder', price: 3 },
    { product: 'Eraser', price: 1.5 },
    { product: 'Stapler', price: 4.99 },
    { product: 'Ruler', price: 2.5 },
  ], null, 2) + '\n',
});

const encoder = new TextEncoder();
const generatedRoots = ['/bin', '/usr/bin', '/dev', '/proc'];
const isGenerated = path => generatedRoots.some(root => path === root || path.startsWith(root + '/'));

export function truncateOutput(value, limit = 6_000) {
  return value.length > limit
    ? value.slice(0, limit) + '\n[Output truncated at 6,000 characters; use head, grep, or a narrower query.]'
    : value;
}

function result(content, details = {}) {
  return { content: truncateOutput(content), details };
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function objectSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function stringSchema(description) {
  return { type: 'string', ...(description ? { description } : {}) };
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

/** A JavaScript-only shell: no host filesystem, network, Python, or JavaScript command. */
export function createWorkspace(files = DEFAULT_FILES, entries) {
  const initialFiles = entries
    ? Object.fromEntries(entries.filter(([, entry]) => entry.type === 'file').map(([path, entry]) => [
      path, { mode: entry.mode, content: base64ToBytes(entry.base64) },
    ]))
    : files;
  const bash = new Bash({
    files: initialFiles,
    cwd: WORKSPACE_ROOT,
    executionLimitProfile: 'hardened',
    executionLimits: { ...EXECUTION_LIMITS },
  });
  const resolve = path => bash.fs.resolvePath(WORKSPACE_ROOT, path);
  const ready = (async () => {
    // File construction creates parents; restore their original modes afterward.
    for (const [path, entry] of entries ?? []) {
      if (entry.type === 'directory') {
        await bash.fs.mkdir(path, { recursive: true });
        await bash.fs.chmod(path, entry.mode);
      } else if (entry.type === 'symlink') {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        await bash.fs.mkdir(parent, { recursive: true });
        await bash.fs.symlink(entry.target, path);
      }
    }
  })();

  async function read(path, { signal } = {}) {
    await ready;
    checkAbort(signal);
    return bash.fs.readFile(resolve(path));
  }

  async function write(path, content, { signal } = {}) {
    await ready;
    checkAbort(signal);
    if (typeof content !== 'string') throw new TypeError('File content must be a UTF-8 string.');
    if (encoder.encode(content).length > MAX_EDITOR_BYTES) throw new Error('The editor accepts files up to 1 MiB.');
    const absolutePath = resolve(path);
    await bash.fs.mkdir(absolutePath.slice(0, absolutePath.lastIndexOf('/')) || '/', { recursive: true });
    checkAbort(signal);
    await bash.fs.writeFile(absolutePath, content);
  }

  const tools = [
    {
      name: 'bash',
      description: 'Run a bash command in /workspace. Supports cat, ls, grep, sed, awk, jq, sort, pipes, redirects, and shell scripts. No network, Node.js, Python, npm, or native binaries. Files persist across commands; cd and variables reset each call.',
      parameters: objectSchema({ command: stringSchema('The shell command to execute.') }),
      async execute({ command }, { signal } = {}) {
        await ready;
        checkAbort(signal);
        const execution = await bash.exec(command, { signal });
        checkAbort(signal);
        const content = `${execution.stdout}${execution.stderr ? '\nSTDERR:\n' + execution.stderr : ''}\nExit code: ${execution.exitCode}`;
        // The agent's repeated-failure guard relies on tools rejecting failed commands.
        if (execution.exitCode !== 0) {
          const error = new Error(truncateOutput(content));
          error.exitCode = execution.exitCode;
          throw error;
        }
        return result(content, { exitCode: execution.exitCode });
      },
    },
    {
      name: 'read',
      description: 'Read a UTF-8 text file. Use bash head/grep for large files.',
      parameters: objectSchema({ path: stringSchema() }),
      async execute({ path }, { signal } = {}) {
        await ready;
        checkAbort(signal);
        const absolutePath = await bash.fs.realpath(resolve(path));
        return result(await read(absolutePath, { signal }), { path: absolutePath });
      },
    },
    {
      name: 'write',
      description: 'Create or replace a UTF-8 text file. Parent directories are created.',
      parameters: objectSchema({ path: stringSchema(), content: stringSchema() }),
      async execute({ path, content }, context = {}) {
        await write(path, content, context);
        return result('Wrote ' + resolve(path));
      },
    },
    {
      name: 'edit',
      description: 'Replace one exact occurrence of oldText with newText in a UTF-8 file. oldText must match exactly once.',
      parameters: objectSchema({ path: stringSchema(), oldText: stringSchema(), newText: stringSchema() }),
      async execute({ path, oldText, newText }, context = {}) {
        const content = await read(path, context);
        if (!oldText || content.split(oldText).length !== 2) {
          throw new Error('oldText must match exactly once. Read the file first.');
        }
        await write(path, content.replace(oldText, () => newText), context);
        return result('Edited ' + resolve(path));
      },
    },
  ];

  async function snapshot() {
    await ready;
    const files = {};
    for (const path of bash.fs.getAllPaths().sort()) {
      if (!isGenerated(path) && (await bash.fs.lstat(path)).isFile) files[path] = await bash.fs.readFile(path);
    }
    return files;
  }

  async function serialize() {
    await ready;
    const entries = [];
    for (const path of bash.fs.getAllPaths().sort()) {
      if (isGenerated(path)) continue;
      const stat = await bash.fs.lstat(path);
      if (stat.isSymbolicLink) {
        entries.push([path, { type: 'symlink', target: await bash.fs.readlink(path) }]);
      } else if (stat.isDirectory) {
        entries.push([path, { type: 'directory', mode: stat.mode }]);
      } else if (stat.isFile) {
        entries.push([path, { type: 'file', base64: bytesToBase64(await bash.fs.readFileBuffer(path)), mode: stat.mode }]);
      }
    }
    return entries;
  }

  return { bash, tools, ready, read, write, snapshot, serialize };
}

/** Persist workspace files and conversation state in IndexedDB. */
export async function createStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw new Error('Browser storage is unavailable.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other tabs to enable browser storage.'));
  });
  return {
    async load() {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('state');
        const request = transaction.objectStore('state').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Loading browser storage was aborted.'));
      });
    },
    async save(state) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put(state, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Saving browser storage was aborted.'));
      });
    },
    close() { db.close(); },
  };
}
