# Offline AI Assistant Architecture

This document captures the discovery and model decision for a secondary local-first AI assistant on a Windows 11 laptop with 16 GB system RAM, an NVIDIA RTX 3050 Laptop GPU with 4 GB VRAM, and limited SSD space. The assistant is intended for coding, defensive cybersecurity and networking work, university study support, local document retrieval, and supervised trading research.

## Discovery Snapshot

Discovery was attempted from the Codex workspace on 2026-07-10. The available command results were:

| Check | Result |
| --- | --- |
| `ollama --version` | `ollama` was not found on PATH. Treat Ollama as not installed or not exposed to the shell yet. |
| `ollama list` | Failed because `ollama` was not found. No installed model inventory could be collected. |
| `ollama ps` | Failed because `ollama` was not found. No running model inventory could be collected. |
| `nvidia-smi` | NVIDIA driver 581.57, CUDA 13.0, RTX 3050 Laptop GPU, 4096 MiB VRAM, 1919 MiB already in use at discovery time. |
| `Get-CimInstance Win32_ComputerSystem` | Access denied in the sandbox. Issue-provided 16 GB RAM is used as the planning limit. |
| `Get-CimInstance Win32_VideoController` | Access denied in the sandbox. `nvidia-smi` confirms 4 GB VRAM. |

The key practical constraint is not just 4 GB total VRAM, but that Windows desktop applications may already consume close to half of it. The design therefore assumes partial GPU offload or CPU fallback and avoids large local models.

## Source Review

The Ollama library was reviewed directly before selecting models:

- `qwen2.5-coder`: sizes 0.5B, 1.5B, 3B, 7B, 14B, 32B; 32K context; 3B download listed at about 1.9 GB and 7B at about 4.7 GB. Source: https://ollama.com/library/qwen2.5-coder
- `llama3.2`: 1B and 3B small general models; 128K context; 3B download listed at about 2.0 GB. Source: https://ollama.com/library/llama3.2
- `phi4-mini`: 3.8B model; 128K context; download listed at about 2.5 GB; function calling support noted by Ollama. Source: https://ollama.com/library/phi4-mini
- `gemma3`: 270M, 1B, 4B, 12B, 27B; 4B download listed at about 3.3 GB; 128K context for 4B and above. Source: https://ollama.com/library/gemma3
- `qwen3-coder`: 30B local model listed at about 19 GB and a 480B model requiring far more memory; not suitable for this hardware. Source: https://ollama.com/library/qwen3-coder
- `devstral`: 24B coding model listed at about 14 GB; strong coding-agent positioning, but too large for 16 GB RAM and 4 GB VRAM. Source: https://ollama.com/library/devstral
- `deepseek-coder-v2`: 16B model listed at about 8.9 GB; too large for comfortable laptop use under the stated constraints. Source: https://ollama.com/library/deepseek-coder-v2

## Model Comparison

| Candidate | Role fit | Download size | Context listed by Ollama | Hardware fit | Notes |
| --- | --- | ---: | ---: | --- | --- |
| `qwen2.5-coder:3b` | Coding default | ~1.9 GB | 32K | Best | Best balance for Python, JS, Git, debugging, and code explanation on constrained hardware. |
| `llama3.2:3b` | General fallback | ~2.0 GB | 128K | Best | Stronger for summaries, study notes, planning, and broad writing than a code-only model. |
| `phi4-mini:3.8b` | Reasoning alternate | ~2.5 GB | 128K | Good | Useful for logic and structured reasoning; may be slower than 3B models. Requires Ollama 0.5.13+. |
| `gemma3:4b` | General/vision optional | ~3.3 GB | 128K | Borderline | Good general model, but 4 GB VRAM plus current desktop VRAM pressure makes it less comfortable. Requires Ollama 0.6+. |
| `qwen2.5-coder:7b` | Higher-quality coding stretch | ~4.7 GB | 32K | Borderline/slow | Better code quality, but likely paging or slow CPU fallback on 16 GB RAM and 4 GB VRAM. |
| `deepseek-coder-v2:16b` | Coding | ~8.9 GB | 160K | Not recommended | Too large for stable daily local use on this machine. |
| `devstral:24b` | Agentic coding | ~14 GB | 128K | Not recommended | Excellent target class, but sized for substantially stronger hardware. |
| `qwen3-coder:30b` | Agentic coding | ~19 GB | 256K | Not recommended | High-quality but outside the laptop budget. |

## Final Model Decision

Use a small two-model setup:

1. Default coding and cybersecurity model: `qwen2.5-coder:3b`
   - Parameter size: 3B.
   - Quantization: Ollama tag default quantization for `qwen2.5-coder:3b`; verify exact quantization with `ollama show qwen2.5-coder:3b` after installation.
   - Why selected: strongest practical coding fit under the hardware limit. It is small enough to remain responsive while still being purpose-built for code generation, code reasoning, and code fixing.
   - Expected resources: about 1.9 GB model download; plan for roughly 3-6 GB system RAM depending on context length and offload; VRAM use should stay manageable with a modest context if Windows has free GPU memory.

2. General study, writing, summarization, and fallback model: `llama3.2:3b`
   - Parameter size: 3B.
   - Quantization: Ollama tag default quantization for `llama3.2:3b`; verify with `ollama show llama3.2:3b`.
   - Why selected: small general model with a large advertised context and broad instruction-following use cases. It complements the coding model without doubling storage pressure too much.
   - Expected resources: about 2.0 GB model download; similar RAM profile to the coding model.

Fallback if performance is poor: `qwen2.5-coder:1.5b` for coding and `llama3.2:1b` for general work. These trade answer quality for lower memory pressure and faster startup.

Stretch model to test only after benchmarks: `qwen2.5-coder:7b`, with concurrency set to 1, context capped to 2048-4096, and the expectation of slower CPU fallback. Do not make it the default unless benchmarks show it remains stable.

## Recommended Runtime Limits

| Setting | Recommendation |
| --- | --- |
| Context length | Start at 4096 tokens for daily use. Increase to 8192 only when memory and latency are acceptable. Avoid using advertised 32K/128K windows by default on this laptop. |
| Concurrent models | 1 loaded model at a time. |
| Parallel requests | 1. |
| Retrieval chunking | 500-900 tokens per chunk with 80-120 token overlap. |
| Retrieval top-k | 4-6 chunks by default. |
| GPU use | Allow Ollama to offload automatically; expect partial GPU or CPU fallback when VRAM is already occupied. |
| Storage guardrail | Keep total local model storage under 15 GB unless explicitly reviewed. |

## Assistant Components

The lightest maintainable setup is:

- Ollama for local inference.
- A browser UI only if needed: Open WebUI is convenient, but it should be optional because Docker can add memory and disk overhead. Start with Ollama plus CLI/API, then add Open WebUI only if the laptop remains responsive.
- VS Code integration for coding can be added later, configured to use `qwen2.5-coder:3b`.
- A small approved-folder retrieval process for notes and project documents. Avoid indexing the whole profile, operating system, dependency folders, binaries, credentials, or browser data.
- Static profiles in `offline-ai/model-profiles.json` so the user can switch behavior without creating an autonomous agent.

## Safety Boundaries

- Bind services to `127.0.0.1` by default.
- Do not expose Ollama or a UI to the internet without authentication and a separate security review.
- Do not index `.env`, tokens, password stores, SSH keys, browser profiles, virtual environments, `node_modules`, binaries, archives, or full disk roots.
- Do not enable autonomous exploitation, live broker order execution, or unattended trading.
- Require explicit user approval before editing files, deleting files, deleting indexes, removing models, or changing firewall/network exposure.

## Limitations

Because Ollama is not currently available on PATH in this environment, the final installed-model decision must be confirmed after setup by running `scripts/Test-OfflineAIReadiness.ps1` and the benchmark checklist. The architectural recommendation is intentionally conservative so the first usable system is stable instead of impressive on paper and painful in practice.
