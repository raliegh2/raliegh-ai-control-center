# Offline AI Operator Guide

This guide is for day-to-day use after setup.

## Switch Models

List installed models:

```powershell
ollama list
```

Run the coding model:

```powershell
ollama run qwen2.5-coder:3b
```

Run the general model:

```powershell
ollama run llama3.2:3b
```

Use fallback models when the laptop is under load:

```powershell
ollama run qwen2.5-coder:1.5b
ollama run llama3.2:1b
```

## Add Approved Documents

1. Place school, project, lab, or trading research files under an approved folder listed in `offline-ai/knowledge-base-policy.example.json`.
2. Keep original files outside the retrieval index if they include secrets, credentials, private browser data, or unrelated personal records.
3. Rebuild the retrieval index using the retrieval tool's documented rebuild command.
4. Ask a test question and confirm the answer cites the expected source file.

## Keep Private Files Excluded

Never index:

- `.env` files
- API keys, tokens, secrets, credential stores, password files
- SSH keys and certificates
- browser profiles and cookies
- `node_modules`, `.venv`, `venv`, `.git`, build outputs, caches
- archives, binaries, VM images, disk images, and large media folders
- full `C:\`, Windows system folders, or the whole user profile

## Recover From High RAM or VRAM Usage

1. Stop active prompts.
2. Close extra browser tabs, games, launchers, or GPU-heavy apps.
3. Check active model sessions:

```powershell
ollama ps
nvidia-smi
```

4. Switch to a smaller model:

```powershell
ollama run qwen2.5-coder:1.5b
```

5. Restart Ollama if it remains stuck.

## Recover From Slow Responses

- Reduce context to 2048-4096.
- Use one model at a time.
- Avoid loading large PDFs directly into the prompt.
- Prefer retrieval snippets over pasting full documents.
- Use `qwen2.5-coder:1.5b` or `llama3.2:1b` while other applications are open.

## Recover From Ollama Errors

Check version and installed models:

```powershell
ollama --version
ollama list
```

Check whether a model is already running:

```powershell
ollama ps
```

Try a small known model:

```powershell
ollama run llama3.2:1b
```

If model files appear corrupt, remove and re-pull only the affected model after confirming:

```powershell
ollama rm model-name:tag
ollama pull model-name:tag
```

## Security Rules

- Keep services bound to `127.0.0.1`.
- Do not expose Ollama, Open WebUI, or retrieval services to the internet without a separate security review.
- Do not use the assistant as an autonomous exploitation agent.
- Keep trading support educational, simulated, or supervised.
- Require explicit approval before file edits, deletions, model removals, external network exposure, or indexing new folders.
