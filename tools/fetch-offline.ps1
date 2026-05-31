<#
  fetch-offline.ps1 — download every library + model weight ANCHOR needs so
  LOCAL mode runs with zero network. Idempotent: existing non-empty files are
  skipped. Use -Force to re-download everything.

  Footprint (q8 weights): ~250 MB. Run from anywhere:
      powershell -ExecutionPolicy Bypass -File tools/fetch-offline.ps1
#>
param([switch]$Force, [switch]$With360)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

# repo root = parent of this script's folder
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$THREE = 'https://cdn.jsdelivr.net/npm/three@0.180.0'
$THREE_GH = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r180'
$TF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2/dist'
$KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist'
$PHON = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist'
$HF = 'https://huggingface.co'
$LLM = 'HuggingFaceTB/SmolLM2-135M-Instruct'
$LLM360 = 'HuggingFaceTB/SmolLM2-360M-Instruct'
$TTS = 'onnx-community/Kokoro-82M-v1.0-ONNX'
$STT = 'onnx-community/whisper-tiny.en'
$VOICES = @('af_heart','af_bella','af_nicole','am_michael','am_fenrir','am_puck','bf_emma','bm_george')

# --- build the download list: @{ U = url; P = local path } ---
$items = New-Object System.Collections.Generic.List[object]
function Add-Item($u, $p) { $items.Add(@{ U = $u; P = $p }) }

# three.js core + face model (three.webgpu.js imports ./three.core.js)
Add-Item "$THREE/build/three.webgpu.js" 'vendor/three/build/three.webgpu.js'
Add-Item "$THREE/build/three.core.js" 'vendor/three/build/three.core.js'
Add-Item "$THREE_GH/examples/models/gltf/facecap.glb" 'vendor/three/facecap.glb'

# three.js addons (mirror the jsm tree so their relative imports resolve)
$addons = @(
  'environments/RoomEnvironment.js',
  'loaders/GLTFLoader.js',
  'loaders/KTX2Loader.js',
  'libs/ktx-parse.module.js',
  'libs/zstddec.module.js',
  'libs/meshopt_decoder.module.js',
  'libs/basis/basis_transcoder.js',
  'libs/basis/basis_transcoder.wasm',
  'math/ColorSpaces.js',
  'utils/BufferGeometryUtils.js',
  'utils/WorkerPool.js'
)
foreach ($a in $addons) { Add-Item "$THREE/examples/jsm/$a" "vendor/three/jsm/$a" }

# Transformers.js (self-contained min bundle) + onnxruntime wasm binary
# (shared by chat AND kokoro; the bundle fetches only the .wasm via wasmPaths)
Add-Item "$TF/transformers.min.js" 'vendor/transformers/transformers.min.js'
Add-Item "$TF/ort-wasm-simd-threaded.jsep.mjs" 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs'
Add-Item "$TF/ort-wasm-simd-threaded.jsep.wasm" 'vendor/transformers/ort-wasm-simd-threaded.jsep.wasm'

# kokoro-js + phonemizer (non-bundled; resolve their bare imports via import map)
Add-Item "$KOKORO/kokoro.js" 'vendor/kokoro/kokoro.js'
Add-Item "$PHON/phonemizer.js" 'vendor/phonemizer/phonemizer.js'

# LLM weights (q8) + tokenizer
foreach ($f in @('config.json','generation_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.json','merges.txt','onnx/model_quantized.onnx')) {
  Add-Item "$HF/$LLM/resolve/main/$f" "models/$LLM/$f"
}
# Kokoro weights (q8) + tokenizer + curated voices
foreach ($f in @('config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx')) {
  Add-Item "$HF/$TTS/resolve/main/$f" "models/$TTS/$f"
}
foreach ($v in $VOICES) { Add-Item "$HF/$TTS/resolve/main/voices/$v.bin" "models/$TTS/voices/$v.bin" }

# Whisper (voice input) weights (q8) + tokenizer
foreach ($f in @('config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.json','merges.txt','added_tokens.json','normalizer.json','onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx')) {
  Add-Item "$HF/$STT/resolve/main/$f" "models/$STT/$f"
}

# Optional: the larger 360M model for the in-app model picker (+~365 MB)
if ($With360) {
  foreach ($f in @('config.json','generation_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.json','merges.txt','onnx/model_quantized.onnx')) {
    Add-Item "$HF/$LLM360/resolve/main/$f" "models/$LLM360/$f"
  }
}

# --- download ---
$n = 0; $skipped = 0; $total = $items.Count
foreach ($it in $items) {
  $n++
  $dir = Split-Path -Parent $it.P
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ((Test-Path $it.P) -and -not $Force -and (Get-Item $it.P).Length -gt 0) {
    $skipped++; Write-Host ("[{0,3}/{1}] skip  {2}" -f $n, $total, $it.P) -ForegroundColor DarkGray
    continue
  }
  Write-Host ("[{0,3}/{1}] get   {2}" -f $n, $total, $it.P) -ForegroundColor Cyan
  $ok = $false
  for ($try = 1; $try -le 3 -and -not $ok; $try++) {
    try { Invoke-WebRequest -Uri $it.U -OutFile $it.P -UseBasicParsing; $ok = $true }
    catch { Write-Host ("        retry {0}: {1}" -f $try, $_.Exception.Message) -ForegroundColor Yellow; Start-Sleep -Seconds 2 }
  }
  if (-not $ok) { throw "Failed to download $($it.U)" }
}

$bytes = (Get-ChildItem -Recurse vendor, models -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host ("Done. {0} files ({1} skipped). Offline payload: {2:N1} MB" -f $total, $skipped, ($bytes / 1MB)) -ForegroundColor Green
Write-Host "Flip the WEB/LOCAL switch in the app to run fully offline." -ForegroundColor Green
