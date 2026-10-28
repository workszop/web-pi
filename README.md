---
title: LFM3 WebGPU Workspace
emoji: 💧
colorFrom: blue
colorTo: green
sdk: static
app_file: dist/index.html
pinned: false
short_description: LFM3 coding agent running locally with WebGPU
models:
  - LiquidAI/LFM3-1.7B-GGUF
tags:
  - webgpu
  - gguf
  - text-generation
  - agents
  - just-bash
thumbnail: https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/Kk4s5HUtlMVLMi2hehCJG.png
---

# LFM3 WebGPU Workspace

LFM3-1.7B runs locally in your browser with a terminal, editor, virtual shell,
file tools, and persistent conversations.

## Model

Choose a quantization in the header or download dialog before loading:

| Choice | File in `LiquidAI/LFM3-1.7B-GGUF` |
| --- | --- |
| **Q4_K_M** (default) | `LFM3-1.7B-Q4_K_M.gguf` |
| **QAD · Q4_0** | `LFM3-1.7B-QAD-Q4_0.gguf` |

The default loads by repository ID; QAD passes its filename through `file`.

A third choice, **VL-2B · 4-bit · vision**, loads
[`onnx-community/LFM3-VL-2B-ONNX`](https://huggingface.co/onnx-community/LFM3-VL-2B-ONNX)
(`q4` files: 4-bit weights with fp32 math, about 1.5 GB) through transformers.js
4.3.2 from jsDelivr. The `q4f16` build was rejected because its fp16 math gives
garbage on some GPUs (Intel Xe-LPG). It uses the same tools and agent loop. Upload `.png .jpg .webp .gif .bmp` images (up to
5 MiB) and name them in a message, e.g. *What is in photo.jpg?*, to attach them.
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

