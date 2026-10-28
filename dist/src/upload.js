// Upload helper: drag-and-drop onto the workspace, pre-checks with per-file feedback,
// and a "what works" popover. Valid files are handed to the bundle's own #upload
// change handler, which writes them through the worker.

import { IMAGE_TYPES, MAX_IMAGE_BYTES, VL_CHOICE } from './config.js';
import { rpc } from './worker-rpc.js';

// ─── Constants ───
const MAX_FILE_BYTES = 1024 ** 2;
const WORKSPACE_ROOT = '/workspace/';
const SETTLE_TIMEOUT_MS = 10_000;
const BINARY_HINTS = Object.freeze({
  pdf: 'PDF is not supported. Copy its text into a .txt or .md file.',
  doc: 'Word files are not supported. Save as .txt or .md.',
  docx: 'Word files are not supported. Save as .txt or .md.',
  odt: 'Document files are not supported. Save as .txt or .md.',
  rtf: 'RTF is not supported. Save as .txt or .md.',
  xls: 'Excel files are not supported. Export the sheet as .csv.',
  xlsx: 'Excel files are not supported. Export the sheet as .csv.',
  ods: 'Spreadsheet files are not supported. Export the sheet as .csv.',
  ppt: 'Presentations are not supported. Copy the text into a .md file.',
  pptx: 'Presentations are not supported. Copy the text into a .md file.',
  key: 'Presentations are not supported. Copy the text into a .md file.',
  heic: 'HEIC images are not supported. Convert to .jpg or .png first.',
  heif: 'HEIF images are not supported. Convert to .jpg or .png first.',
  tif: 'TIFF images are not supported. Convert to .jpg or .png first.',
  tiff: 'TIFF images are not supported. Convert to .jpg or .png first.',
  zip: 'Archives are not supported. Upload the files inside instead.',
  gz: 'Archives are not supported. Upload the files inside instead.',
  tar: 'Archives are not supported. Upload the files inside instead.',
  '7z': 'Archives are not supported. Upload the files inside instead.',
  rar: 'Archives are not supported. Upload the files inside instead.',
  mp3: 'Audio is not supported.',
  wav: 'Audio is not supported.',
  mp4: 'Video is not supported.',
  mov: 'Video is not supported.',
  exe: 'Programs and other binary files are not supported.',
  dmg: 'Programs and other binary files are not supported.',
  sqlite: 'Database files are not supported. Export tables as .csv or .sql.',
  db: 'Database files are not supported. Export tables as .csv or .sql.',
});

// ─── State ───
const state = {
  phase: 'idle', // idle | dragging | checking | writing | done | error
  dragDepth: 0,
  forwarding: false,
  added: [],
  rejected: [], // { name, reason }
  imageAdded: false,
};

// ─── DOM refs ───
const panel = document.querySelector('#workspace-panel');
const input = document.querySelector('#upload');
const statusEl = document.querySelector('#upload-status');
const notice = document.querySelector('#notice');

// ─── Helpers ───
const extensionOf = name => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const existingPaths = () => new Set([...document.querySelectorAll('#files button[title]')].map(b => b.title));
const formatSize = bytes => (bytes >= 10 * MAX_FILE_BYTES ? (bytes / MAX_FILE_BYTES).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024).toLocaleString('en') + ' KiB');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const isImageName = name => Object.hasOwn(IMAGE_TYPES, extensionOf(name));

async function check(file, taken) {
  const hint = BINARY_HINTS[extensionOf(file.name)];
  if (hint) return hint;
  if (taken.has(WORKSPACE_ROOT + file.name)) return 'A file with this name already exists. Rename or delete it first.';
  if (isImageName(file.name)) {
    return file.size > MAX_IMAGE_BYTES ? `Too large (${formatSize(file.size)}). Images can be up to 5 MiB.` : '';
  }
  if (file.size > MAX_FILE_BYTES) return `Too large (${formatSize(file.size)}). The limit is 1 MiB per file.`;
  const text = await file.text();
  if (text.includes('\0')) return 'Looks like a binary file. Only plain-text files and images work.';
  return '';
}

async function uploadImages(images) {
  for (const file of images) {
    try {
      await rpc('write_bytes', { path: WORKSPACE_ROOT + file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      state.added.push(file.name);
      state.imageAdded = true;
    } catch (error) {
      state.rejected.push({ name: file.name, reason: error.message });
    }
  }
}

async function upload(files) {
  if (!files.length) return;
  state.phase = 'checking';
  state.added = [];
  state.rejected = [];
  state.imageAdded = false;
  render();

  const taken = existingPaths();
  const accepted = new DataTransfer();
  const images = [];
  for (const file of files) {
    const reason = await check(file, taken);
    if (reason) state.rejected.push({ name: file.name, reason });
    else {
      if (isImageName(file.name)) images.push(file);
      else accepted.items.add(file);
      taken.add(WORKSPACE_ROOT + file.name);
    }
  }

  if (images.length) {
    state.phase = 'writing';
    render();
    await uploadImages(images);
  }

  if (accepted.files.length) {
    state.phase = 'writing';
    render();
    const noticeBefore = notice.hidden ? '' : notice.textContent;
    // Snapshot names: the FileList empties once the bundle clears the input.
    const names = [...accepted.files].map(file => file.name);
    input.files = accepted.files;
    state.forwarding = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.forwarding = false;
    const error = await settle(noticeBefore);
    const written = existingPaths();
    for (const name of names) {
      if (written.has(WORKSPACE_ROOT + name)) state.added.push(name);
      else state.rejected.push({ name, reason: error || 'Not saved.' });
    }
  }
  input.value = '';
  state.phase = state.rejected.length ? 'error' : 'done';
  render();
}

// The bundle clears the input on success and shows #notice on failure.
async function settle(noticeBefore) {
  const start = Date.now();
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    await delay(100);
    if (!notice.hidden && notice.textContent && notice.textContent !== noticeBefore) return notice.textContent;
    if (input.value === '') { await delay(150); return ''; }
  }
  return 'Timed out while saving.';
}

// ─── Render ───
function render() {
  panel.dataset.upload = state.phase;
  statusEl.dataset.added = String(state.added.length);
  statusEl.dataset.rejected = String(state.rejected.length);
  statusEl.replaceChildren();
  statusEl.hidden = state.phase === 'idle' || state.phase === 'dragging';
  if (statusEl.hidden) return;

  const line = (text, cls) => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    statusEl.append(p);
  };
  if (state.phase === 'checking') return line('Checking files…', 'upload-progress');
  if (state.phase === 'writing') return line('Saving to /workspace…', 'upload-progress');
  if (state.added.length) line(`Added ${state.added.join(', ')}`, 'upload-ok');
  if (state.imageAdded && document.querySelector('#model-file')?.value !== VL_CHOICE) {
    line('Only LFM3-VL-2B can see images. Pick "VL-2B · 4-bit · vision" before loading, then ask about the image.', 'upload-progress');
  }
  for (const { name, reason } of state.rejected) line(`${name}: ${reason}`, 'upload-bad');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'quiet upload-dismiss';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => { state.phase = 'idle'; render(); });
  statusEl.append(close);
}

// ─── Listeners ───
const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');

// Intercept picker uploads before the bundle's onchange so they get the same pre-checks.
window.addEventListener('change', event => {
  if (event.target !== input || state.forwarding) return;
  event.stopImmediatePropagation();
  upload([...input.files]);
}, true);

panel.addEventListener('dragenter', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  state.dragDepth += 1;
  if (state.phase !== 'checking' && state.phase !== 'writing') { state.phase = 'dragging'; render(); }
});
panel.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
panel.addEventListener('dragleave', event => {
  if (!hasFiles(event)) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (!state.dragDepth && state.phase === 'dragging') { state.phase = 'idle'; render(); }
});
panel.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  state.dragDepth = 0;
  upload([...event.dataTransfer.files]);
});

// Image files show a placeholder in the editor; keep it read-only so saving cannot replace the image.
const editor = document.querySelector('#editor');
const filename = document.querySelector('#filename');
new MutationObserver(() => {
  const image = isImageName(filename.textContent.trim());
  editor.readOnly = image;
  editor.dataset.image = String(image);
}).observe(filename, { childList: true, characterData: true, subtree: true });

// A file dropped outside the workspace must not navigate away from the app.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, event => { if (hasFiles(event)) event.preventDefault(); });
}

// ─── Init ───
render();
