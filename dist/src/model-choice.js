import { MODEL_FILE, MODEL_FILES } from './config.js';

const choices = () => [...document.querySelectorAll('#model-file, #model-file-dialog')];

export function selectedModelFile() {
  const value = document.querySelector('#model-file')?.value;
  return MODEL_FILES.includes(value) ? value : MODEL_FILE;
}

export function initializeModelChoice(file) {
  const value = MODEL_FILES.includes(file) ? file : MODEL_FILE;
  for (const select of choices()) select.value = value;
}

export function setModelChoiceLocked(locked) {
  for (const select of choices()) select.disabled = locked;
}

for (const select of choices()) {
  select.addEventListener('change', () => initializeModelChoice(select.value));
}
