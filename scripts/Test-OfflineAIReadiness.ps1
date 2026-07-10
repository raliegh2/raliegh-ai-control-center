param(
  [string]$PreferredModel = "qwen2.5-coder:3b",
  [string]$FallbackModel = "llama3.2:3b",
  [int]$MinimumFreeDiskGb = 20
)

$ErrorActionPreference = "Continue"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title =="
}

function Invoke-Safe {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  try {
    & $Command
  } catch {
    Write-Warning "$Label failed: $($_.Exception.Message)"
  }
}

Write-Section "System"
Invoke-Safe "Computer memory query" {
  $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $ramGb = [math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
  Write-Host "Total RAM: $ramGb GB"
  if ($ramGb -lt 16) {
    Write-Warning "RAM is below the planned 16 GB baseline. Use 1B-1.5B fallback models first."
  }
}

Invoke-Safe "Disk query" {
  $drive = Get-PSDrive -Name C -ErrorAction Stop
  $freeGb = [math]::Round($drive.Free / 1GB, 2)
  if ($freeGb -le 0) {
    Write-Warning "C: free space could not be determined from this shell."
  } else {
    Write-Host "C: free space: $freeGb GB"
  }
  if ($freeGb -gt 0 -and $freeGb -lt $MinimumFreeDiskGb) {
    Write-Warning "Free disk is below $MinimumFreeDiskGb GB. Avoid pulling additional models."
  }
}

Write-Section "GPU"
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Invoke-Safe "nvidia-smi" {
    nvidia-smi
  }
} else {
  Write-Warning "nvidia-smi was not found. NVIDIA driver or PATH may need attention."
}

Invoke-Safe "Video controller query" {
  Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, AdapterRAM
}

Write-Section "Ollama"
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  Invoke-Safe "Ollama version" {
    ollama --version
  }

  Invoke-Safe "Installed models" {
    ollama list
  }

  Invoke-Safe "Running models" {
    ollama ps
  }

  $models = @(ollama list 2>$null)
  if ($models -notmatch [regex]::Escape($PreferredModel)) {
    Write-Warning "Preferred model '$PreferredModel' is not installed. Run: ollama pull $PreferredModel"
  }
  if ($models -notmatch [regex]::Escape($FallbackModel)) {
    Write-Warning "Fallback/general model '$FallbackModel' is not installed. Run: ollama pull $FallbackModel"
  }
} else {
  Write-Warning "Ollama was not found on PATH. Install Ollama or open a new terminal after installation."
}

Write-Section "Model Size Guardrails"
$largeModelPatterns = @(
  "qwen3-coder:30b",
  "qwen3-coder",
  "devstral",
  "deepseek-coder-v2",
  "qwen2.5-coder:14b",
  "qwen2.5-coder:32b",
  "gemma3:12b",
  "gemma3:27b"
)

foreach ($pattern in $largeModelPatterns) {
  if ($PreferredModel -like "*$pattern*" -or $FallbackModel -like "*$pattern*") {
    Write-Warning "Configured model '$pattern' is likely too large for 16 GB RAM and 4 GB VRAM."
  }
}

Write-Host ""
Write-Host "Readiness check complete. No files or models were deleted or modified."
