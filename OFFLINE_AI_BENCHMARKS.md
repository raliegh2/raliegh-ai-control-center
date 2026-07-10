# Offline AI Benchmark Checklist

Use this checklist after installing Ollama and pulling the recommended models. Record results before changing the default model.

For repeatable measurements, run:

```powershell
.\scripts\Measure-OllamaModels.ps1
```

To test a specific installed subset:

```powershell
.\scripts\Measure-OllamaModels.ps1 -Models llama3.2:3b,qwen3:4b,qwen2.5-coder:7b
```

The script writes `offline-ai/local-benchmark-results.md` and unloads each model after each prompt with `keep_alive=0s`.

## Test Matrix

| Area | Prompt | Model | Latency | RAM/VRAM | Quality notes | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| Coding | Explain this Python traceback and suggest the smallest safe fix. | `qwen2.5-coder:3b` | | | | |
| Coding | Refactor a small Express route to validate input and return clear errors. | `qwen2.5-coder:3b` | | | | |
| Git/GitHub | Draft a PR summary from a short change list and testing notes. | `qwen2.5-coder:3b` | | | | |
| Cybersecurity | Interpret an Nmap scan for an authorized lab host and list defensive next steps. | `qwen2.5-coder:3b` | | | | |
| Networking | Explain why DNS resolution can work on one network but fail on another. | `llama3.2:3b` | | | | |
| Academic writing | Summarize lecture notes into revision bullets with cited source filenames. | `llama3.2:3b` | | | | |
| Retrieval | Answer a question using only files in the approved knowledge-base folder. | `llama3.2:3b` | | | | |
| Trading research | Review a backtest note and separate factual metrics from speculative interpretation. | `llama3.2:3b` | | | | |
| Stress | Repeat a coding prompt after a browser, VS Code, and terminal are open. | `qwen2.5-coder:3b` | | | | |

## Measurement Commands

Before each run:

```powershell
ollama ps
nvidia-smi
Get-Process ollama -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,CPU,WorkingSet64
```

After each run:

```powershell
ollama ps
nvidia-smi
```

## Pass Criteria

- First-token latency is acceptable for daily use.
- The laptop remains responsive.
- No Windows paging/freezing during normal prompts.
- No out-of-memory errors.
- Answers follow the local-only, defensive-security, and trading-research boundaries.
- Coding answers are specific enough to use but still ask before editing files.
- Retrieval answers cite the source file path or filename.

## Revision Rules

If `qwen2.5-coder:3b` is too slow or unstable, switch coding to `qwen2.5-coder:1.5b`.

If `llama3.2:3b` is too slow or unstable, switch general work to `llama3.2:1b`.

If both 3B models are stable and quality is not high enough for coding, test `qwen2.5-coder:7b` with context capped at 2048-4096 and concurrency set to 1. Keep it as an opt-in profile unless it remains stable across the full checklist.
