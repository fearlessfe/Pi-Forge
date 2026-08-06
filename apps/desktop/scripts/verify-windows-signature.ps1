param(
  [string]$ReleaseDirectory = "release",
  [string]$ExpectedPublisher = "Pi Forge"
)

$ErrorActionPreference = "Stop"
$release = Resolve-Path $ReleaseDirectory
$app = Join-Path $release "win-unpacked\pi-forge.exe"
$installer = Get-ChildItem $release -Filter "Pi-Forge-*-win-x64.exe" | Select-Object -First 1
if (-not (Test-Path $app) -or -not $installer) { throw "Cannot locate signed app executable and NSIS installer." }

foreach ($file in @($app, $installer.FullName)) {
  $signature = Get-AuthenticodeSignature $file
  if ($signature.Status -ne "Valid") { throw "Invalid Authenticode signature for ${file}: $($signature.StatusMessage)" }
  if (-not $signature.SignerCertificate.Subject.Contains($ExpectedPublisher)) { throw "Unexpected publisher for ${file}: $($signature.SignerCertificate.Subject)" }
  if (-not $signature.TimeStamperCertificate) { throw "Missing RFC3161 timestamp for ${file}." }
  & signtool.exe verify /pa /all /v $file
  if ($LASTEXITCODE -ne 0) { throw "signtool verification failed for ${file}." }
}

Write-Host "[release-signature] verified Authenticode publisher and RFC3161 timestamp for app and installer"
