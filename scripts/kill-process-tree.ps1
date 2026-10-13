param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId
)

$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$tracked = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$tracked.Add($RootProcessId)

do {
  $foundChild = $false
  foreach ($process in $processes) {
    if ($tracked.Contains([int]$process.ParentProcessId) -and $tracked.Add([int]$process.ProcessId)) {
      $foundChild = $true
    }
  }
} while ($foundChild)

foreach ($processId in $tracked) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
