param(
  [switch]$ConfirmRealConnection,
  [string]$NodePath
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmRealConnection) {
  throw "Real Weixin connection requires the explicit -ConfirmRealConnection switch."
}

$appRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Split-Path -Parent $appRoot
$dataRoot = Join-Path $serviceRoot "runtime-data"
$logRoot = Join-Path $serviceRoot "logs"
$node = if ([string]::IsNullOrWhiteSpace($NodePath)) {
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
} else {
  $NodePath
}
$cli = Join-Path $appRoot "src\cli.mjs"

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw "Bundled Node.js runtime was not found."
}

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "Bridge CLI was not found."
}

$existingBridge = @(
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      $_.CommandLine -and
      $_.ExecutablePath.Equals($node, [StringComparison]::OrdinalIgnoreCase) -and
      $_.CommandLine.Contains($cli)
    }
)

if ($existingBridge.Count -gt 0) {
  exit 0
}

$mutex = [Threading.Mutex]::new($false, "Local\WeixinSafeBridge")
$hasLock = $false
try {
  try {
    $hasLock = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $hasLock = $true
  }

  if (-not $hasLock) {
    exit 0
  }

  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $logFile = Join-Path $logRoot ("bridge-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
  $controlRoot = Join-Path $dataRoot "local-control"
  $sdkStateRoot = Join-Path $dataRoot "sdk-state"
  New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $sdkStateRoot -Force | Out-Null
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $controlRoot /inheritance:r /grant:r "*${currentSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict the local-control directory ACL."
  }
  & $icacls $sdkStateRoot /inheritance:r /grant:r "*${currentSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict the sdk-state directory ACL."
  }

  $env:WEIXIN_BRIDGE_DATA_DIR = $dataRoot
  $env:WEIXIN_ENABLE_REAL_CONNECTION = "1"
  $env:WEIXIN_ENABLE_LOCAL_OUTBOUND = "1"

  Push-Location $appRoot
  try {
    & $node $cli run --confirm-real-connection *>> $logFile
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  if ($hasLock) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
