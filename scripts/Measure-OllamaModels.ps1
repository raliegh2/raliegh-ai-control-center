param(
  [string[]]$Models = @(),
  [string]$PromptFile = "offline-ai/benchmark-prompts.json",
  [string]$OutputPath = "offline-ai/local-benchmark-results.md",
  [int]$ContextTokens = 4096,
  [int]$PredictTokens = 160,
  [int]$TimeoutSeconds = 180,
  [string]$OllamaBaseUrl = "http://127.0.0.1:11434"
)

$ErrorActionPreference = "Stop"

function Get-NvidiaSummary {
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    return "nvidia-smi unavailable"
  }

  try {
    return (nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits) -join "; "
  } catch {
    return "nvidia-smi failed: $($_.Exception.Message)"
  }
}

function Invoke-OllamaGenerate {
  param(
    [string]$Model,
    [string]$Prompt
  )

  $body = @{
    model = $Model
    prompt = $Prompt
    stream = $false
    keep_alive = "0s"
    options = @{
      num_ctx = $ContextTokens
      num_predict = $PredictTokens
      temperature = 0.2
      top_p = 0.9
    }
  } | ConvertTo-Json -Depth 5

  $request = @{
    Uri = "$OllamaBaseUrl/api/generate"
    Method = "Post"
    Body = $body
    ContentType = "application/json"
    TimeoutSec = $TimeoutSeconds
  }

  $started = Get-Date
  $response = Invoke-RestMethod @request
  $elapsed = ((Get-Date) - $started).TotalSeconds

  [pscustomobject]@{
    Response = $response
    WallSeconds = [math]::Round($elapsed, 2)
  }
}

function Convert-NanoSecondsToSeconds {
  param($Value)
  if ($null -eq $Value -or $Value -eq 0) {
    return $null
  }
  return [math]::Round(([double]$Value / 1000000000), 2)
}

function Format-Rate {
  param($Tokens, $DurationNs)
  if ($null -eq $Tokens -or $null -eq $DurationNs -or $DurationNs -eq 0) {
    return ""
  }
  return [math]::Round(([double]$Tokens / ([double]$DurationNs / 1000000000)), 2)
}

if (-not (Test-Path $PromptFile)) {
  throw "Prompt file not found: $PromptFile"
}

$tags = Invoke-RestMethod -Uri "$OllamaBaseUrl/api/tags" -TimeoutSec 15
$installed = @($tags.models | ForEach-Object { $_.name })
if ($Models.Count -eq 0) {
  $Models = $installed
}

$missing = @($Models | Where-Object { $_ -notin $installed })
if ($missing.Count -gt 0) {
  Write-Warning "Skipping missing model(s): $($missing -join ', ')"
  $Models = @($Models | Where-Object { $_ -in $installed })
}

if ($Models.Count -eq 0) {
  throw "No requested models are installed."
}

$promptSpec = Get-Content -Raw $PromptFile | ConvertFrom-Json
$prompts = @($promptSpec.prompts)
$results = New-Object System.Collections.Generic.List[object]

foreach ($model in $Models) {
  foreach ($prompt in $prompts) {
    Write-Host "Benchmarking $model / $($prompt.id)..."
    $gpuBefore = Get-NvidiaSummary
    try {
      $run = Invoke-OllamaGenerate -Model $model -Prompt $prompt.prompt
      $gpuAfter = Get-NvidiaSummary
      $r = $run.Response
      $errorMessage = $_.Exception.Message
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $errorMessage = $_.ErrorDetails.Message
      } elseif ($_.Exception.Response) {
        try {
          $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
          $responseBody = $reader.ReadToEnd()
          if ($responseBody) {
            $errorMessage = $responseBody
          }
        } catch {
          $errorMessage = $_.Exception.Message
        }
      }
      $results.Add([pscustomobject]@{
        Model = $model
        PromptId = $prompt.id
        Area = $prompt.area
        Status = "pass"
        WallSeconds = $run.WallSeconds
        TotalSeconds = Convert-NanoSecondsToSeconds $r.total_duration
        LoadSeconds = Convert-NanoSecondsToSeconds $r.load_duration
        PromptTokens = $r.prompt_eval_count
        PromptTokensPerSecond = Format-Rate $r.prompt_eval_count $r.prompt_eval_duration
        OutputTokens = $r.eval_count
        OutputTokensPerSecond = Format-Rate $r.eval_count $r.eval_duration
        GpuBefore = $gpuBefore
        GpuAfter = $gpuAfter
        Sample = (($r.response -replace "\r?\n", " ") -replace "\|", "/").Trim()
        Error = ""
      })
    } catch {
      $gpuAfter = Get-NvidiaSummary
      $results.Add([pscustomobject]@{
        Model = $model
        PromptId = $prompt.id
        Area = $prompt.area
        Status = "fail"
        WallSeconds = ""
        TotalSeconds = ""
        LoadSeconds = ""
        PromptTokens = ""
        PromptTokensPerSecond = ""
        OutputTokens = ""
        OutputTokensPerSecond = ""
        GpuBefore = $gpuBefore
        GpuAfter = $gpuAfter
        Sample = ""
        Error = ($errorMessage -replace "\r?\n", " ")
      })
    }
  }
}

$byModel = $results | Group-Object Model | ForEach-Object {
  $passed = @($_.Group | Where-Object Status -eq "pass")
  [pscustomobject]@{
    Model = $_.Name
    Passed = $passed.Count
    Failed = @($_.Group | Where-Object Status -ne "pass").Count
    AvgWallSeconds = if ($passed.Count) { [math]::Round(($passed | Measure-Object WallSeconds -Average).Average, 2) } else { "" }
    AvgOutputTokensPerSecond = if ($passed.Count) { [math]::Round(($passed | Measure-Object OutputTokensPerSecond -Average).Average, 2) } else { "" }
  }
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Local Ollama Benchmark Results")
$lines.Add("")
$lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add("")
$lines.Add("Settings: context ``$ContextTokens``, max output ``$PredictTokens``, timeout ``$TimeoutSeconds`` seconds, temperature ``0.2``.")
$lines.Add("")
$lines.Add("## Installed Models")
$lines.Add("")
$lines.Add("| Model | Parameter size | Quantization | Size GB | Context | Capabilities |")
$lines.Add("| --- | ---: | --- | ---: | ---: | --- |")
foreach ($m in $tags.models) {
  $sizeGb = [math]::Round($m.size / 1GB, 2)
  $capabilities = ($m.capabilities -join ", ")
  $lines.Add(("| ``{0}`` | {1} | {2} | {3} | {4} | {5} |" -f $m.name, $m.details.parameter_size, $m.details.quantization_level, $sizeGb, $m.details.context_length, $capabilities))
}

$lines.Add("")
$lines.Add("## Summary")
$lines.Add("")
$lines.Add("| Model | Passed | Failed | Avg wall seconds | Avg output tokens/sec |")
$lines.Add("| --- | ---: | ---: | ---: | ---: |")
foreach ($row in $byModel) {
  $lines.Add(("| ``{0}`` | {1} | {2} | {3} | {4} |" -f $row.Model, $row.Passed, $row.Failed, $row.AvgWallSeconds, $row.AvgOutputTokensPerSecond))
}

$lines.Add("")
$lines.Add("## Detailed Runs")
$lines.Add("")
$lines.Add("| Model | Prompt | Area | Status | Wall sec | Output tok/s | Output tokens | GPU before | GPU after | Error |")
$lines.Add("| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |")
foreach ($row in $results) {
  $safeError = ($row.Error -replace "\|", "/")
  $lines.Add(("| ``{0}`` | ``{1}`` | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} |" -f $row.Model, $row.PromptId, $row.Area, $row.Status, $row.WallSeconds, $row.OutputTokensPerSecond, $row.OutputTokens, $row.GpuBefore, $row.GpuAfter, $safeError))
}

$lines.Add("")
$lines.Add("## Recommendation Rule")
$lines.Add("")
$lines.Add("Use the fastest passing small model for daily general work. Prefer the coding-specialized model for code tasks only if it remains responsive and does not force heavy VRAM pressure. Keep ``num_ctx`` at the lowest passing benchmark value, then increase gradually only after another benchmark passes.")

$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}

$lines | Set-Content -Path $OutputPath -Encoding UTF8
Write-Host "Wrote $OutputPath"
