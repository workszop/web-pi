// Image preview in the editor: selecting a workspace image shows the picture over the read-only
// text placeholder. Bytes come from the worker (read_image), shown through a blob URL.

import { IMAGE_TYPES } from './config.js';
import { rpc } from './worker-rpc.js';

// ─── State ───
const state = { path: null, url: null, request: 0 };

// ─── DOM refs ───
const filename = document.querySelector('#filename');
const preview = document.querySelector('#image-preview');
const image = preview.querySelector('img');
const info = preview.querySelector('.image-info');
const open = preview.querySelector('.image-open');

// ─── Helpers ───
const isImage = path => path.includes('.') && Object.hasOwn(IMAGE_TYPES, path.slice(path.lastIndexOf('.') + 1).toLowerCase());
const formatSize = bytes => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024).toLocaleString('en')} KiB`);

function release() {
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
}

async function show(path) {
  const request = ++state.request;
  state.path = path;
  release();
  render('loading');
  try {
    const { type, bytes } = await rpc('read_image', { path });
    if (request !== state.request) return;   // another file was selected meanwhile
    state.url = URL.createObjectURL(new Blob([bytes], { type }));
    image.onload = () => {
      if (request !== state.request) return;
      const kind = type.split('/')[1].toUpperCase();
      render('ready', `${image.naturalWidth} × ${image.naturalHeight} px · ${formatSize(bytes.length)} · ${kind}`);
    };
    image.onerror = () => request === state.request && render('error', 'This image could not be displayed.');
    image.alt = path.slice(path.lastIndexOf('/') + 1);
    image.src = state.url;
    open.href = state.url;
  } catch (error) {
    if (request === state.request) render('error', error.message);
  }
}

function hide() {
  state.request++;
  state.path = null;
  release();
  image.removeAttribute('src');
  render('hidden');
}

// ─── Render ───
function render(phase, text = '') {
  preview.hidden = phase === 'hidden';
  preview.dataset.state = phase;
  preview.dataset.path = state.path ?? '';
  info.textContent = phase === 'loading' ? 'Loading preview…' : text;
  open.hidden = phase !== 'ready';
}

// ─── Listeners ───
function update() {
  const path = filename.textContent.trim();
  if (isImage(path)) { if (path !== state.path) show(path); }
  else if (state.path) hide();
}
new MutationObserver(update).observe(filename, { childList: true, characterData: true, subtree: true });

// ─── Init ───
update();
