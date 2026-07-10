# Local Ollama Benchmark Results

Generated: 2026-07-09 20:56:27 -04:00

Settings: context `1024`, max output `32`, timeout `120` seconds, temperature `0.2`.

## Installed Models

| Model | Parameter size | Quantization | Size GB | Context | Capabilities |
| --- | ---: | --- | ---: | ---: | --- |
| `llama3.1:8b` | 8.0B | Q4_K_M | 4.58 | 131072 | completion, tools |
| `llama3.2:3b` | 3.2B | Q4_K_M | 1.88 | 131072 | completion, tools |
| `qwen2.5-coder:7b` | 7.6B | Q4_K_M | 4.36 | 32768 | completion, tools, insert |
| `qwen3:4b` | 4.0B | Q4_K_M | 2.33 | 262144 | completion, tools, thinking |
| `qwen2.5:3b` | 3.1B | Q4_K_M | 1.8 | 32768 | completion, tools |

## Summary

| Model | Passed | Failed | Avg wall seconds | Avg output tokens/sec |
| --- | ---: | ---: | ---: | ---: |
| `llama3.2:3b` | 4 | 0 | 7.08 | 56.27 |
| `qwen2.5:3b` | 4 | 0 | 6.53 | 54.3 |
| `qwen3:4b` | 4 | 0 | 13.01 | 26.26 |

## Detailed Runs

| Model | Prompt | Area | Status | Wall sec | Output tok/s | Output tokens | GPU before | GPU after | Error |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `llama3.2:3b` | `coding-debug` | Coding | pass | 7.15 | 55.79 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1611, 2355, 2 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1458, 2508, 92 |  |
| `llama3.2:3b` | `cyber-defense` | Cybersecurity | pass | 7.24 | 56.94 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 92 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 94 |  |
| `llama3.2:3b` | `school-summary` | Schoolwork | pass | 6.8 | 56.51 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 94 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1434, 2532, 14 |  |
| `llama3.2:3b` | `trading-research` | Trading research | pass | 7.11 | 55.85 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1434, 2532, 71 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1434, 2532, 94 |  |
| `qwen2.5:3b` | `coding-debug` | Coding | pass | 7.39 | 54.79 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1434, 2532, 94 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1437, 2529, 1 |  |
| `qwen2.5:3b` | `cyber-defense` | Cybersecurity | pass | 5.47 | 56.48 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1437, 2529, 1 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 93 |  |
| `qwen2.5:3b` | `school-summary` | Schoolwork | pass | 6.56 | 51.93 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 93 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1479, 2487, 94 |  |
| `qwen2.5:3b` | `trading-research` | Trading research | pass | 6.72 | 53.99 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1479, 2487, 94 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1480, 2486, 93 |  |
| `qwen3:4b` | `coding-debug` | Coding | pass | 12.59 | 27.77 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1480, 2486, 93 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 47 |  |
| `qwen3:4b` | `cyber-defense` | Cybersecurity | pass | 12.96 | 25.85 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1439, 2527, 47 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1371, 2595, 21 |  |
| `qwen3:4b` | `school-summary` | Schoolwork | pass | 12.89 | 28.94 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1371, 2595, 21 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1361, 2605, 47 |  |
| `qwen3:4b` | `trading-research` | Trading research | pass | 13.59 | 22.48 | 32 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1361, 2605, 47 | NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 1324, 2642, 35 |  |

## Recommendation Rule

Use the fastest passing small model for daily general work. Prefer the coding-specialized model for code tasks only if it remains responsive and does not force heavy VRAM pressure. Keep `num_ctx` at the lowest passing benchmark value, then increase gradually only after another benchmark passes.
