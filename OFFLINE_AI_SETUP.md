# Offline AI Assistant Setup

These steps install a secondary local-first AI assistant on Windows. The setup keeps services local, avoids large models, and does not replace any existing primary AI tools.

## 1. Install Ollama

1. Download Ollama for Windows from https://ollama.com/download.
2. Install it normally.
3. Open a new PowerShell window and confirm:

```powershell
ollama --version
ollama list
ollama ps
```

If PowerShell cannot find `ollama`, restart the terminal or add the Ollama install directory to PATH.

## 2. Pull the Recommended Models

Start with the small coding model:

```powershell
ollama pull qwen2.5-coder:3b
ollama run qwen2.5-coder:3b
```

Add the general fallback model:

```powershell
ollama pull llama3.2:3b
ollama run llama3.2:3b
```

Optional low-resource fallbacks:

```powershell
ollama pull qwen2.5-coder:1.5b
ollama pull llama3.2:1b
```

Do not pull `qwen3-coder:30b`, `devstral:24b`, or other large models on this laptop unless you intentionally want a slow experiment and have checked disk space first.

## 3. Keep Context Conservative

Use profile settings from `offline-ai/model-profiles.json`. Start with:

- context: 4096 tokens
- temperature: 0.2 for coding and cybersecurity
- concurrency: 1
- one loaded model at a time

Only increase context after benchmarks show that memory use and latency are acceptable.

## 4. Validate the Laptop

Run the read-only readiness script:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\Test-OfflineAIReadiness.ps1
```

The script reports RAM, GPU/VRAM when available, disk space, Ollama version, installed models, and running models. It never deletes models or files.

## 5. Optional Open WebUI

Open WebUI is useful, but it usually means Docker or another service. On this laptop, make it optional.

Recommended sequence:

1. Use Ollama CLI/API first.
2. Benchmark the two small models.
3. Add Open WebUI only if the machine remains responsive.
4. Bind UI access to localhost only.

If Docker Desktop is already installed and acceptable:

```powershell
docker run -d `
  --name open-webui `
  -p 127.0.0.1:3000:8080 `
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 `
  -v open-webui:/app/backend/data `
  --restart unless-stopped `
  ghcr.io/open-webui/open-webui:main
```

Open http://127.0.0.1:3000. Do not publish this port on a public interface.

Shutdown:

```powershell
docker stop open-webui
```

Remove the container without deleting the named data volume:

```powershell
docker rm open-webui
```

## 6. Knowledge Base Folders

Create explicit folders for approved documents, for example:

```text
C:\Users\ralie\Documents\AI-Knowledge\School
C:\Users\ralie\Documents\AI-Knowledge\Cybersecurity-Labs
C:\Users\ralie\Documents\AI-Knowledge\Projects
C:\Users\ralie\Documents\AI-Knowledge\Trading-Research
```

Use `offline-ai/knowledge-base-policy.example.json` as the ingestion policy. Keep retrieval limited to approved folders and supported text-like file types.

## 7. Updates and Maintenance

Update Ollama:

```powershell
ollama --version
```

Download the latest Windows installer from Ollama when needed. Then verify models:

```powershell
ollama list
ollama show qwen2.5-coder:3b
ollama show llama3.2:3b
```

Remove a model only after confirming it is no longer needed:

```powershell
ollama rm model-name:tag
```

Clear or rebuild a retrieval index only through the retrieval tool's documented command. Do not delete source documents as part of index maintenance.

## 8. Rollback and Uninstall

Stop running models:

```powershell
ollama ps
```

Close active chat sessions or stop the UI. If using Docker:

```powershell
docker stop open-webui
docker rm open-webui
```

Remove optional models:

```powershell
ollama rm qwen2.5-coder:3b
ollama rm llama3.2:3b
```

Uninstall Ollama from Windows Apps only if you want to remove the runtime entirely.

## 9. Operating Boundaries

- Use this as a secondary assistant.
- Keep it local-first and localhost-only.
- Use cybersecurity features only for authorized labs, owned systems, defensive work, and coursework.
- Keep trading features educational, simulated, or supervised. Do not connect broker APIs for autonomous live trading.
- Ask before file edits, destructive operations, external exposure, or indexing new folders.
