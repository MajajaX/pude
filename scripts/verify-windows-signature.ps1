param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedThumbprint,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [Parameter(Mandatory = $true)]
  [string]$LicensePath,
  [Parameter(Mandatory = $true)]
  [string]$NoticePath,
  [Parameter(Mandatory = $true)]
  [string]$LicenseAppendixPath
)

$ErrorActionPreference = "Stop"
$script:processTreeCleanupUncertain = $false

if ($env:GITHUB_ACTIONS -ne "true" -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw "Payload installation verification is limited to an ephemeral GitHub Actions runner."
}

$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$LicensePath = (Resolve-Path -LiteralPath $LicensePath).Path
$NoticePath = (Resolve-Path -LiteralPath $NoticePath).Path
$LicenseAppendixPath = (Resolve-Path -LiteralPath $LicenseAppendixPath).Path
$ExpectedThumbprint = $ExpectedThumbprint.Replace(" ", "").ToUpperInvariant()
$expectedVersionPattern = "^$([regex]::Escape($ExpectedVersion))(?:\.0)?(?:\+.*)?$"

function Assert-PeImage([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($stream.Length -lt 0x40) { throw "File is too small to be a PE image: $Path" }
    $stream.Position = 0x3c
    $peHeaderOffset = $reader.ReadInt32()
    if ($peHeaderOffset -lt 0x40 -or $peHeaderOffset + 6 -gt $stream.Length) {
      throw "File has an invalid PE header offset: $Path"
    }
    $stream.Position = $peHeaderOffset
    if ([System.Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -ne "PE`0`0") {
      throw "File does not have a valid PE header: $Path"
    }
    return $reader.ReadUInt16()
  } finally {
    $stream.Dispose()
  }
}

function Resolve-X64SignTool {
  $sdkBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $sdkBin -PathType Container) {
    $versionDirectories = @(Get-ChildItem -LiteralPath $sdkBin -Directory | Where-Object { $_.Name -match '^\d+(?:\.\d+){2,3}$' } | Sort-Object { [version]$_.Name } -Descending)
    foreach ($versionDirectory in $versionDirectories) {
      $candidate = Join-Path $versionDirectory.FullName "x64\signtool.exe"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $unversionedCandidate = Join-Path $sdkBin "x64\signtool.exe"
    if (Test-Path -LiteralPath $unversionedCandidate -PathType Leaf) { return $unversionedCandidate }
  }

  $command = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
  if ($null -ne $command -and $command.Source -match '[\\/]x64[\\/]signtool\.exe$') { return $command.Source }
  throw "Cannot find the x64 Windows SDK signtool.exe; install is blocked rather than using an unknown SDK tool."
}

function Stop-ProcessTreeBounded([System.Diagnostics.Process]$Process, [string]$Label) {
  $taskkillFailure = $null
  $isTaskkill = $Process.ProcessName -ieq "taskkill"
  if (-not $Process.HasExited -and -not $isTaskkill) {
    try {
      $taskkillInfo = [System.Diagnostics.ProcessStartInfo]::new()
      $taskkillInfo.FileName = Join-Path $env:SystemRoot "System32\taskkill.exe"
      $taskkillInfo.Arguments = "/PID $($Process.Id) /T /F"
      $taskkillInfo.UseShellExecute = $false
      $taskkillInfo.CreateNoWindow = $true
      $killer = [System.Diagnostics.Process]::Start($taskkillInfo)
      [void]$verificationProcesses.Add($killer)
      if (-not $killer.WaitForExit(10000)) {
        try { $killer.Kill() } catch {}
        if (-not $killer.WaitForExit(10000)) {
          $taskkillFailure = "taskkill.exe exceeded both bounded wait periods"
        } else {
          $taskkillFailure = "taskkill.exe exceeded its 10000 ms deadline"
        }
      } elseif ($killer.ExitCode -ne 0) {
        $taskkillFailure = "taskkill.exe exited with code $($killer.ExitCode)"
      }
    } catch {
      $taskkillFailure = $_.Exception.Message
    }
  }
  if ($null -ne $taskkillFailure) {
    $script:processTreeCleanupUncertain = $true
  }

  if (-not $Process.HasExited) {
    try { $Process.Kill() } catch {}
  }
  if (-not $Process.WaitForExit(10000)) {
    throw "$Label remained active after bounded tree and direct termination attempts."
  }
  if ($null -ne $taskkillFailure) {
    throw "$Label process exited after direct termination, but process-tree cleanup was uncertain: $taskkillFailure"
  }
}

function Invoke-BoundedProcess([string]$FileName, [string]$Arguments, [int]$TimeoutMilliseconds, [string]$Label) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  [void]$verificationProcesses.Add($process)
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    Stop-ProcessTreeBounded $process $Label
    throw "$Label exceeded its $TimeoutMilliseconds ms deadline."
  }
  return $process.ExitCode
}

function Snapshot-RegistryKey($BaseKey, [string]$SubKey) {
  $key = $BaseKey.OpenSubKey($SubKey, $false)
  if ($null -eq $key) { return $null }
  try {
    $values = @()
    foreach ($name in $key.GetValueNames()) {
      $values += [pscustomobject]@{
        Name = $name
        Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        Kind = $key.GetValueKind($name)
      }
    }
    $children = @{}
    foreach ($name in $key.GetSubKeyNames()) {
      $children[$name] = Snapshot-RegistryKey $key $name
    }
    return @{ Values = $values; Children = $children }
  } finally {
    $key.Dispose()
  }
}

function Restore-RegistryContents($Key, $Snapshot) {
  foreach ($value in $Snapshot.Values) {
    $Key.SetValue($value.Name, $value.Value, $value.Kind)
  }
  foreach ($name in $Snapshot.Children.Keys) {
    $child = $Key.CreateSubKey($name)
    try { Restore-RegistryContents $child $Snapshot.Children[$name] } finally { $child.Dispose() }
  }
}

function Restore-RegistryKey($BaseKey, [string]$SubKey, $Snapshot) {
  $existing = $BaseKey.OpenSubKey($SubKey, $true)
  if ($null -ne $existing) {
    $existing.Dispose()
    $BaseKey.DeleteSubKeyTree($SubKey)
  }
  if ($null -ne $Snapshot) {
    $key = $BaseKey.CreateSubKey($SubKey)
    try { Restore-RegistryContents $key $Snapshot } finally { $key.Dispose() }
  }
}

 $verificationProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
 $installRoot = Join-Path $env:RUNNER_TEMP "pude-release-verification-$([Guid]::NewGuid().ToString('N'))"
 $registrySnapshots = @()
 try {
if ($installRoot -match '\s') { throw "RUNNER_TEMP must not contain spaces for bounded NSIS payload verification." }
$installerSignature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
if ($installerSignature.Status -ne "Valid" -or $installerSignature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $ExpectedThumbprint) {
  throw "NSIS installer is not validly signed by the expected certificate."
}
$installerVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerPath).ProductVersion
if ($installerVersion -notmatch $expectedVersionPattern) {
  throw "NSIS installer has unexpected internal product version '$installerVersion'."
}
$null = Assert-PeImage $InstallerPath
$signTool = Resolve-X64SignTool
$installerSignExit = Invoke-BoundedProcess $signTool "verify /pa /all /v `"$InstallerPath`"" 60000 "SignTool installer verification"
if ($installerSignExit -ne 0) { throw "SignTool rejected the NSIS installer with exit code $installerSignExit." }

foreach ($candidate in @(@{ Path = $LicensePath; Name = "LICENSE" }, @{ Path = $NoticePath; Name = "THIRD_PARTY_NOTICES.md" }, @{ Path = $LicenseAppendixPath; Name = "THIRD_PARTY_LICENSES.md" })) {
  $source = Join-Path (Split-Path -Parent $PSScriptRoot) $candidate.Name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Repository source is missing $($candidate.Name)." }
  if ((Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
    throw "Release sidecar $($candidate.Name) differs from the checked-out source."
  }
}

$registryLocations = @(
  @{ Base = [Microsoft.Win32.Registry]::CurrentUser; Path = "Software\Classes\Directory\shell\pude" },
  @{ Base = [Microsoft.Win32.Registry]::CurrentUser; Path = "Software\Classes\Directory\Background\shell\pude" },
  @{ Base = [Microsoft.Win32.Registry]::LocalMachine; Path = "Software\Classes\Directory\shell\pude" },
  @{ Base = [Microsoft.Win32.Registry]::LocalMachine; Path = "Software\Classes\Directory\Background\shell\pude" }
)
foreach ($location in $registryLocations) {
  $registrySnapshots += @{ Location = $location; Snapshot = (Snapshot-RegistryKey $location.Base $location.Path) }
}
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $InstallerPath
  $processInfo.Arguments = "/S /D=$installRoot"
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $installerProcess = [System.Diagnostics.Process]::Start($processInfo)
  [void]$verificationProcesses.Add($installerProcess)
  if (-not $installerProcess.WaitForExit(120000)) {
    Stop-ProcessTreeBounded $installerProcess "Silent NSIS install"
    throw "Silent NSIS install exceeded its 120000 ms deadline."
  }
  if ($installerProcess.ExitCode -ne 0) { throw "Silent NSIS install exited with code $($installerProcess.ExitCode)." }
  $appPath = Join-Path $installRoot "pude.exe"
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "The NSIS installer did not install pude.exe at its destination." }
  $appVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appPath).ProductVersion
  if ($appVersion -notmatch $expectedVersionPattern) { throw "Installed app has unexpected product version '$appVersion'." }
  $appMachine = Assert-PeImage $appPath
  if ($appMachine -ne 0x8664) { throw ("Installed app is not x64 (PE machine: 0x{0:x4})." -f $appMachine) }
  $appSignature = Get-AuthenticodeSignature -LiteralPath $appPath
  if ($appSignature.Status -ne "Valid" -or $appSignature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $ExpectedThumbprint) {
    throw "Installed pude.exe is not validly signed by the expected certificate."
  }
  $appSignExit = Invoke-BoundedProcess $signTool "verify /pa /all /v `"$appPath`"" 60000 "SignTool app verification"
  if ($appSignExit -ne 0) { throw "SignTool rejected the installed pude.exe with exit code $appSignExit." }

  $resourceDirectory = Join-Path $installRoot "resources"
  if (-not (Test-Path -LiteralPath $resourceDirectory -PathType Container)) { $resourceDirectory = $installRoot }
  foreach ($candidate in @(@{ Path = $LicensePath; Name = "LICENSE" }, @{ Path = $NoticePath; Name = "THIRD_PARTY_NOTICES.md" }, @{ Path = $LicenseAppendixPath; Name = "THIRD_PARTY_LICENSES.md" })) {
    $installedLocations = @((Join-Path $resourceDirectory $candidate.Name), (Join-Path $installRoot $candidate.Name)) | Select-Object -Unique
    $matchingFiles = @($installedLocations | Where-Object {
      (Test-Path -LiteralPath $_ -PathType Leaf) -and
      (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash
    })
    if ($matchingFiles.Count -ne 1) { throw "Installed app must contain exactly one intact bundled $($candidate.Name)." }
  }

  $uninstaller = Join-Path $installRoot "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    $uninstallExit = Invoke-BoundedProcess $uninstaller "/S" 60000 "NSIS test uninstall"
    if ($uninstallExit -ne 0) { throw "Silent NSIS test uninstall exited with code $uninstallExit." }
  }

  [pscustomobject]@{
    Status = $installerSignature.Status.ToString()
    Thumbprint = $installerSignature.SignerCertificate.Thumbprint
    ProductVersion = $installerVersion
    Machine = "x64"
    AppStatus = $appSignature.Status.ToString()
    AppThumbprint = $appSignature.SignerCertificate.Thumbprint
    AppProductVersion = $appVersion
  } | ConvertTo-Json -Compress
} finally {
  $cleanupFailures = [System.Collections.Generic.List[string]]::new()
  $processIndex = 0
  while ($processIndex -lt $verificationProcesses.Count) {
    $process = $verificationProcesses[$processIndex]
    $processIndex += 1
    try {
      if (-not $process.HasExited) { Stop-ProcessTreeBounded $process "Final verification cleanup" }
    } catch {
      [void]$cleanupFailures.Add($_.Exception.Message)
    }
  }
  $allProcessesStopped = $true
  foreach ($process in $verificationProcesses) {
    try {
      if (-not $process.HasExited) { $allProcessesStopped = $false }
    } catch {
      $allProcessesStopped = $false
      [void]$cleanupFailures.Add($_.Exception.Message)
    }
  }
  if ($allProcessesStopped -and -not $script:processTreeCleanupUncertain) {
    foreach ($snapshot in $registrySnapshots) {
      try {
        Restore-RegistryKey $snapshot.Location.Base $snapshot.Location.Path $snapshot.Snapshot
      } catch {
        [void]$cleanupFailures.Add($_.Exception.Message)
      }
    }
    try {
      if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    } catch {
      [void]$cleanupFailures.Add($_.Exception.Message)
    }
  } else {
    if (-not $allProcessesStopped) {
      [void]$cleanupFailures.Add("Verification subprocesses could not be confirmed stopped; preserving the temporary install directory at $installRoot.")
    }
    if ($script:processTreeCleanupUncertain) {
      [void]$cleanupFailures.Add("A child-process tree could not be fully verified; preserving the temporary install directory at $installRoot.")
    }
  }
  if ($cleanupFailures.Count -gt 0) {
    throw ("Windows verifier cleanup failed: " + ($cleanupFailures -join " | "))
  }
}
