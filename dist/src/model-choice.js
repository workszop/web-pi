import { MODEL_FILE, MODEL_FILES, MODEL_LABELS } from './config.js';

const choices = () => [...document.querySelectorAll('#model-file, #model-file-dialog')];

export function selectedModelFile() {
  const value = document.querySelector('#model-file')?.value;
  return MODEL_FILES.includes(value) ? value : MODEL_FILE;
}

// Name and link of the chosen model in the header, the setup dialog and the terminal status line.
function showModel(value) {
  const { name, url } = MODEL_LABELS[value] ?? MODEL_LABELS[MODEL_FILE];
  globalThis.MODEL_LABEL = name;
  document.documentElement.dataset.model = value;
  for (const link of document.querySelectorAll('.header-model-source, .model-source')) {
    link.href = url;
    link.title = `View ${name} weights on Hugging Face`;
    if (link.matches('.header-model-source')) link.setAttribute('aria-label', `${name} on Hugging Face (opens in a new tab)`);
    const label = link.querySelector('strong') ?? link;
    label.textContent = name;
  }
}

export function initializeModelChoice(file) {
  const value = MODEL_FILES.includes(file) ? file : MODEL_FILE;
  for (const select of choices()) select.value = value;
  showModel(value);
}

export function setModelChoiceLocked(locked) {
  for (const select of choices()) select.disabled = locked;
}

for (const select of choices()) {
  select.addEventListener('change', () => initializeModelChoice(select.value));
}
