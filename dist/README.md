---
title: LFM3 WebGPU Workspace
emoji: 💧
colorFrom: blue
colorTo: green
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
short_description: LFM3 coding agent running locally with WebGPU
models:
  - LiquidAI/LFM3-1.7B-GGUF
tags:
  - webgpu
  - gguf
  - text-generation
  - agents
  - just-bash
---

# LFM3 WebGPU Workspace

LFM3-1.7B runs locally in your browser with a terminal, editor, virtual shell,
file tools, and persistent conversations.

## Deploy

Create a **Static Hugging Face Space**, extract this ZIP, and upload its contents
to the repository root. No npm install or build step is required. This README
configures `sdk: static` and `app_file: index.html`.

The root is runnable as-is. `dist/` contains a ready-to-host copy, including its
own README; you can upload those contents instead. Model weights are downloaded
on first use and are not included in the ZIP.

## Run locally

```sh
npm start
```

Requires Node.js 20+ to serve the files. Open http://127.0.0.1:5173 in a
WebGPU-capable browser. Any static server can serve the root or `dist/`.
Use HTTPS for remote hosting; `file://` does not work.

## Model

Choose a quantization in the header or download dialog before loading:

| Choice | File in `LiquidAI/LFM3-1.7B-GGUF` |
| --- | --- |
| **QAD · Q4_0** (default) | `LFM3-1.7B-QAD-Q4_0.gguf` |
| **Q4_K_M** | `LFM3-1.7B-Q4_K_M.gguf` |

QAD passes its filename through `file`; Q4_K_M loads by repository ID (the
library's own default). QAD is the app default: on an Intel iGPU it decoded as
fast as Q4_K_M (14.3 vs 14.8 tok/s, within noise), is 50 MB smaller, and scored
10/10 vs 9/10 on a short question set.

A third choice, **VL-2B · 4-bit · vision**, loads
[`onnx-community/LFM3-VL-2B-ONNX`](https://huggingface.co/onnx-community/LFM3-VL-2B-ONNX)
(`q4` files: 4-bit weights with fp32 math, about 1.5 GB) through transformers.js
4.3.2 from jsDelivr. The `q4f16` build was rejected because its fp16 math gives
garbage on some GPUs (Intel Xe-LPG). It uses the same tools and agent loop. Upload `.png .jpg .webp .gif .bmp` images (up to
5 MiB), then ask about them: name the file (*What is in photo.jpg?*) or just
say "the image" / "zdjęcie" to attach the newest one. A notice shows which file
was attached, and the choice is saved with the message.
The supplied model library includes 17 kernels and 50 variants for these two
files. Reload the page to switch quantization after loading.

**Context defaults to 32,768 tokens**, with up to 4,096 new tokens per reply and
12 agent rounds. The runtime may reduce capacity to fit the device; the terminal
shows the actual capacity after loading. Decoding uses `do_sample: false`.
Settings are in `src/config.js`.

Inference, tools, prompts, and workspace files stay in your browser. Weight
caching is best effort. This is the text-only model; no inference API key is
required.

## Use

- Enter sends; Shift+Enter adds a newline.
- Stop, Escape, or Ctrl+C cancels a running response/tool.
- `/load`, `/new`, `/help`, and `!ls` work in the terminal.
- Read, write, edit, and bash tools use the same virtual filesystem as the editor.
- Upload (button or drag onto the Workspace panel) accepts plain-text files up
  to 1 MiB each; PDF, Office, images, archives and other binaries are rejected
  with a reason. The `?` button lists what works. Export downloads a workspace
  JSON snapshot.
- Files, chats, and the loaded quantization are saved in IndexedDB when available.
- New chat clears conversation history and keeps files.

Try: **Read sales.csv and products.json, calculate total sales revenue, and save
a report.** The starter data totals $144.

The shell provides Bash and text-processing tools. Python, Node.js, npm, native
binaries, and network commands are unavailable. Interrupted partial replies
remain visible but are not included in the model's next prompt. A full context
requires a new chat; history is not silently truncated.

## Intel integrated GPUs

Measured on an Intel Core Ultra (Meteor Lake) iGPU that WebGPU reports as
vendor `intel`, architecture `xe-lpg` (Linux 7.2, i915 driver, Chrome 151 on
Vulkan). LFM3-1.7B decodes at ~15 tok/s but **prefills only ~50 tok/s** there.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GPU device lost … VK_ERROR_DEVICE_LOST` after a long "Reading prompt…" (chat or prompt of ~4,000+ tokens) | One GPU job outlives the i915 preempt timeout (7.5 s on `rcs0`/`ccs0`), so the kernel resets Chrome's GPU context. `journalctl -k` shows `Fence expiration time out … chrome` then `context reset due to GPU hang`. | Start a new chat and keep prompts short (read big files with `head`/`grep`). Untested alternative, as root and reset on reboot: raise `/sys/class/drm/card1/engine/{rcs0,ccs0}/preempt_timeout_ms`; a really hung GPU then freezes the desktop for that long. |
| LFM3-VL-2B returns nonsense even for "What is the capital of France?" (e.g. `Capacity>**n … and, and, and`) | The ONNX `q4f16` build (fp16 math) miscomputes on this GPU. | Use `q4` (4-bit weights, fp32 math). The app ships `q4`; see `VL_DTYPE` in `src/config.js`. |
| Results are wrong only sometimes, with or without `device lost` | Another process using the GPU at the same time; i915 resets contexts under contention. | Run one GPU app at a time, then retest. |

Quick diagnosis, in this order:

1. Identify the GPU in the page console:
   `(await navigator.gpu.requestAdapter()).info` and `adapter.features.has('shader-f16')`.
2. Look for kernel resets at the failure time:
   `journalctl -k --since "-1h" | grep -E "GPU HANG|Fence expiration|context reset"`.
   A hit means a timeout or contention, not app code.
3. Test the model alone with a plain factual prompt (transformers.js below) before
   debugging the app. Garbage here means a dtype or GPU problem.

```js
const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2');
const id = 'onnx-community/LFM3-VL-2B-ONNX', dtype = { vision_encoder: 'q4', embed_tokens: 'q4', decoder_model_merged: 'q4' };
const processor = await T.AutoProcessor.from_pretrained(id);
const model = await T.AutoModelForImageTextToText.from_pretrained(id, { device: 'webgpu', dtype });
const prompt = processor.apply_chat_template([{ role: 'user', content: 'What is the capital of France?' }], { add_generation_prompt: true, enable_thinking: false });
const inputs = await processor(null, prompt, { add_special_tokens: false });
const out = await model.generate({ ...inputs, do_sample: false, max_new_tokens: 30 });
processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0];
```

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `assets/` | Terminal, editor, layout, and styles. |
| `runtime/Lfm3ForCausalLM.js` | Supplied model library. |
| `runtime/agent.js` | Supplied agent loop. |
| `src/agent.worker.js` | Worker entry point and RPC transport. |
| `src/controller.js` | Loading, streaming, tools, cancellation, and saves. |
| `src/config.js` | Model files, limits, and instructions. |
| `src/model-choice.js` | Quantization selectors. |
| `src/upload.js`, `assets/upload.css` | Upload pre-checks, drag-and-drop and file-type help. |
| `src/mascot.js`, `vendor/robot.js`, `assets/mascot-robot.css` | Walking robot mascot (from q223-kiosk-demo). |
| `assets/header.css` | "based on" credit in the header. |
| `src/vl-model.js` | LFM3-VL-2B adapter (transformers.js) with the runtime's generate() shape. |
| `src/worker-hook.js` | Lets `src/upload.js` send image bytes to the worker. |
| `src/conversation.js` | Pi display-message adapter. |
| `src/workspace.js`, `vendor/just-bash.js` | Virtual filesystem, shell, and persistence. |
| `scripts/` | Optional local server and static build. |
| `test/` | Integration tests. |
| `docs/` | Runtime API and implementation notes. |
| `dist/` | Ready-to-host copy. |
| `licenses/`, `NOTICE`, `LICENSE` | Attribution for included components. |

## Validate

```sh
npm test
npm run build
```

The build copies the app to `dist/`. Tests cover the agent/controller with fake
model sessions and the real shell/worker. Actual WebGPU inference and visual
browser checks remain unverified in this environment.
