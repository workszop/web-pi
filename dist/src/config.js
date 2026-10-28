// Keep the tool definitions and instructions stable to reuse the session's KV cache.
export const MODEL_ID = 'LiquidAI/LFM3-1.7B-GGUF';
export const Q4KM_FILE = 'LFM3-1.7B-Q4_K_M.gguf';   // the supplied library's repository default
export const QAD_FILE = 'LFM3-1.7B-QAD-Q4_0.gguf';
// App default: same decode speed as Q4_K_M here, 50 MB smaller, 10/10 vs 9/10 on the bench questions (2026-10-28).
export const MODEL_FILE = QAD_FILE;
// The vision model is a third choice: ONNX weights run by transformers.js, not a GGUF file.
export const VL_CHOICE = 'LFM3-VL-2B-ONNX-q4';
export const VL_MODEL_ID = 'onnx-community/LFM3-VL-2B-ONNX';
// 4-bit weights with fp32 math: the q4f16 (fp16 math) build produces garbage on some GPUs (Intel Xe-LPG here).
export const VL_DTYPE = Object.freeze({ vision_encoder: 'q4', embed_tokens: 'q4', decoder_model_merged: 'q4' });
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
export const MODEL_FILES = Object.freeze([QAD_FILE, Q4KM_FILE, VL_CHOICE]);
export const MODEL_LABELS = Object.freeze({
  [QAD_FILE]: { name: 'LFM3-1.7B', url: 'https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF' },
  [Q4KM_FILE]: { name: 'LFM3-1.7B', url: 'https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF' },
  [VL_CHOICE]: { name: 'LFM3-VL-2B', url: 'https://huggingface.co/onnx-community/LFM3-VL-2B-ONNX' },
});

// Images the vision model can see: workspace files named in a user message.
export const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' });
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const CONTEXT_LENGTH = 32768;
export const MAX_NEW_TOKENS = 4096;
export const MAX_ROUNDS = 12;

export const INSTRUCTIONS = `You are Pi, a coding assistant powered by LFM3-1.7B from Liquid AI.
The model, tools, and workspace run entirely in the user's browser. Workspace files are virtual files stored in this browser, not files on the user's operating system.
Use tools to inspect and change actual workspace files. Never claim a command ran or a file changed without a successful tool result. When the user explicitly asks for a tool, use it.
Working directory: /workspace. Tools: read, write, edit, bash. Keep calls and answers concise.
Bash supports cat, ls, find, grep, sed, awk, jq, sort, wc, printf, pipes, redirects, and shell scripts. Use jq for JSON and awk for CSV and calculations.
Python, Node.js, npm, native binaries, and network commands are unavailable. You may write HTML/CSS/JavaScript with external URLs, but cannot fetch or test those URLs in the shell.
Interpret follow-ups using the conversation. Inspect files before editing. Verify changes with a tool, then give a short factual answer.`;

export const VL_INSTRUCTIONS = INSTRUCTIONS.replace('LFM3-1.7B from Liquid AI', 'LFM3-VL-2B from Liquid AI') + `
You can see images. When the user names a workspace image (.png, .jpg, .webp, .gif, .bmp) in a message, that image is attached to the message; answer from what you see in it. Do not read image files with tools.`;
