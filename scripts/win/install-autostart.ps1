# Install (or remove) the always-on pieces for Tenant AI on Windows (M7):
#
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-autostart.ps1            # install
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-autostart.ps1 -WithSoak  # + soak recorder task
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-autostart.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-autostart.ps1 -Status
#
# 1. Scheduled task "Tenant AI" - At log on of this user, runs
#    scripts\win\autostart.ps1 hidden (launcher + crash-restart loop), no time
#    limit, not stopped on battery. Runs as the current user, interactively
#    (Next, ngrok and the browser all want a logged-in session), so it only
#    needs the user's own rights - no UAC for this part.
# 2. Machine settings that need elevation (one UAC prompt, skipped with -NoAdmin):
#    Fast Startup off (otherwise "shut down" is a hibernate and the at-logon
#    task does not re-run cleanly), never sleep / hibernate on AC, lid close
#    does nothing (laptops), no auto-sleep of the display is left alone.
param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$WithSoak,
  [switch]$NoAdmin,
  [string]$TaskName = 'Tenant AI',
  [string]$SoakTaskName = 'Tenant AI soak'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ps = (Get-Command powershell.exe).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

function Show-Status() {
  foreach ($n in @($TaskName, $SoakTaskName)) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($t) {
      $i = $t | Get-ScheduledTaskInfo
      "{0,-16} {1,-8} last run {2} result {3} next {4}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime
    } else { "{0,-16} not installed" -f $n }
  }
  $hb = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
  "Fast Startup (HiberbootEnabled): $hb   (0 = off, wanted)"
  $ac = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)').Matches.Groups[1].Value
  "Sleep after (AC): $([Convert]::ToInt32($ac,16)) s   (0 = never, wanted)"
}

if ($Status) { Show-Status; exit 0 }

if ($Uninstall) {
  foreach ($n in @($TaskName, $SoakTaskName)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      "removed task '$n'"
    }
  }
  exit 0
}

# ---- 1. scheduled tasks (current user, no elevation) -------------------------
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT20S'   # let the network/ngrok/DNS settle after sign-in
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$action = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $root `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\win\autostart.ps1`""
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Tenant AI: start the launcher at sign-in and restart it if it crashes (scripts\win\autostart.ps1).' -Force | Out-Null
"registered task '$TaskName' (at log on of $user, hidden, crash-restart loop)"

if ($WithSoak) {
  $soakAction = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $root `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"node scripts\stress\soak.mjs --interval 60 *>> .local\log\soak-task.log`""
  $soakTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $soakTrigger.Delay = 'PT60S'
  Register-ScheduledTask -TaskName $SoakTaskName -Action $soakAction -Trigger $soakTrigger -Principal $principal -Settings $settings `
    -Description 'Tenant AI: soak recorder (scripts\stress\soak.mjs) -> parity\win32\soak.jsonl' -Force | Out-Null
  "registered task '$SoakTaskName'"
}

# ---- 2. machine settings (elevated) -----------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$adminScript = @'
$ErrorActionPreference = 'Continue'
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0   # Fast Startup off
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0                                                      # lid close: do nothing
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /setactive SCHEME_CURRENT
Write-Output 'power settings applied'
'@
if ($NoAdmin) {
  "skipped machine settings (-NoAdmin); run again without it, or apply by hand: Fast Startup off, never sleep on AC"
} elseif ($isAdmin) {
  Invoke-Expression $adminScript
} else {
  "machine settings need elevation - approve the UAC prompt (Fast Startup off, never sleep/hibernate on AC, lid close = nothing)"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($adminScript))
  try {
    $p = Start-Process $ps -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc"
    if ($p.ExitCode -ne 0) { "elevated step exited with $($p.ExitCode)" }
  } catch { "UAC declined or failed: $($_.Exception.Message) - apply the settings by hand or re-run later" }
}

""
Show-Status
""
"Test without signing out:  Start-ScheduledTask -TaskName '$TaskName'   then  Invoke-WebRequest http://127.0.0.1:3001/health"
"Stop the running stack:    Set-Content .launcher.stop 1   (or double-click start.cmd to take over in a visible window)"
"Logs:                      .local\log\launcher.log"
