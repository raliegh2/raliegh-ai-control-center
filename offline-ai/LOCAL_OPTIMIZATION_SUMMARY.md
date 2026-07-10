# Local Optimization Summary

Local verification was run against the installed Ollama models on 2026-07-09.

## Installed Models

| Model | Size | Parameters | Quantization | Fit assessment |
| --- | ---: | ---: | --- | --- |
| `llama3.1:8b` | 4.58 GB | 8.0B | Q4_K_M | Too large for current free RAM/VRAM. Keep only if disk is expanded. |
| `qwen2.5-coder:7b` | 4.36 GB | 7.6B | Q4_K_M | Useful coding model, but too heavy for current desktop load. |
| `qwen3:4b` | 2.33 GB | 4.0B | Q4_K_M | Borderline; failed while RAM/VRAM were constrained. |
| `llama3.2:3b` | 1.88 GB | 3.2B | Q4_K_M | Best installed general candidate; passed the quick benchmark. |
| `qwen2.5:3b` | 1.80 GB | 3.1B | Q4_K_M | Best installed lightweight Qwen candidate; fastest average wall time in the quick benchmark. |

## Benchmark Result

The final comparable benchmark used `num_ctx=1024`, `num_predict=32`, temperature `0.2`, and the local Ollama API. Results are stored in `offline-ai/local-benchmark-results.md`.

| Model | Passed | Failed | Avg wall seconds | Avg output tokens/sec | Recommendation |
| --- | ---: | ---: | ---: | ---: | --- |
| `qwen2.5:3b` | 4 | 0 | 6.53 | 54.30 | Best current local default for coding and technical work. |
| `llama3.2:3b` | 4 | 0 | 7.08 | 56.27 | Best current general/study fallback. |
| `qwen3:4b` | 4 | 0 | 13.01 | 26.26 | Keep as opt-in only; roughly half the speed of the 3B models. |

## Current Bottlenecks And Constraints

- Ollama is installed at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, but it is not on PATH.
- `nvidia-smi` showed about 2.3-2.6 GB free VRAM during the passing benchmark.
- C: had roughly 220-245 MB free, so smaller fallback models could not be pulled safely.
- Earlier runs failed when free RAM/VRAM were lower, so this setup is sensitive to other open applications.

## Optimized Local Plan

1. Free disk space before any model changes. Target at least 10 GB free on C:.
2. Close GPU/RAM-heavy apps before running Ollama. During verification, large consumers included Ollama app, memory compression, Roblox, Claude, Chrome, and Codex.
3. Keep `num_ctx=1024` for normal use on this laptop. Test `num_ctx=2048` only after freeing disk and closing heavy apps.
4. Allow Ollama automatic GPU handling for the current 3B models, matching the passing benchmark. If CUDA allocation errors return, free RAM/VRAM and retry; use CPU mode (`num_gpu=0`) only for low-memory fallback tests.
5. After disk space is available, install one low-memory fallback:

```powershell
ollama pull llama3.2:1b
```

6. For coding, install the smaller coding fallback only after disk space is available:

```powershell
ollama pull qwen2.5-coder:1.5b
```

7. Do not pull additional large models. Review and remove unused installed models only with explicit approval:

```powershell
ollama list
ollama rm model-name:tag
```

## Recommended Profile Order

| Situation | Profile/model |
| --- | --- |
| Current local default | `qwen2.5:3b` at `num_ctx=1024`. |
| General/study fallback | `llama3.2:3b` at `num_ctx=1024`. |
| Slower reasoning opt-in | `qwen3:4b` at `num_ctx=1024`. |
| Coding after disk is freed | Pull and test `qwen2.5-coder:3b`; use installed `qwen2.5-coder:7b` only when at least 6 GB RAM is free. |
| Lowest-memory fallback | `llama3.2:1b` after freeing disk and pulling it. |

The installed `qwen2.5-coder:7b` and `llama3.1:8b` should not be daily defaults on the current disk/RAM budget.
