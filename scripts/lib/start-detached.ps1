# Start a process WITHOUT inheriting any handle from this process tree.
#
# Why: Node (libuv) calls CreateProcess with bInheritHandles=TRUE, so a detached
# child inherits every inheritable handle of the Node process - including the
# stdout pipe a parent shell / CI runner gave Node. A long-running service
# (postgres, redis, minio) then keeps that pipe open and whoever is reading it
# waits for EOF until the service dies. This helper calls CreateProcessW with
# bInheritHandles=FALSE and DETACHED_PROCESS (no console either, so closing the
# window that started the launcher cannot take the service down).
#
# Input (env, to avoid quoting hell):  INFRA_SPAWN_CMD   full command line
#                                      INFRA_SPAWN_CWD   working directory
#                                      INFRA_SPAWN_WAIT  "1" -> wait and report EXIT=<code>
# Output: PID=<n> [EXIT=<n>] or ERROR=<win32 code>. Used by scripts/infra.mjs.
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Infra -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct STARTUPINFO {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
  public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
  public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool CreateProcessW(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
  bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
[DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);
'@

$cmd  = $env:INFRA_SPAWN_CMD
$cwd  = $env:INFRA_SPAWN_CWD
$wait = ($env:INFRA_SPAWN_WAIT -eq '1')
if (-not $cmd) { Write-Output 'ERROR=no INFRA_SPAWN_CMD'; exit 2 }
# PowerShell turns $null into "" for string parameters; Win32 needs a real NULL.
$NULLSTR = [NullString]::Value
if (-not $cwd) { $cwd = $NULLSTR }

$DETACHED_PROCESS = 0x00000008; $CREATE_NEW_PROCESS_GROUP = 0x00000200; $CREATE_UNICODE_ENVIRONMENT = 0x00000400
$flags = [uint32]($DETACHED_PROCESS -bor $CREATE_NEW_PROCESS_GROUP -bor $CREATE_UNICODE_ENVIRONMENT)

$si = New-Object Infra.Native+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$pi = New-Object Infra.Native+PROCESS_INFORMATION
$ok = [Infra.Native]::CreateProcessW($NULLSTR, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, $cwd, [ref]$si, [ref]$pi)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output "ERROR=$err"
  exit 1
}
Write-Output "PID=$($pi.dwProcessId)"
if ($wait) {
  [void][Infra.Native]::WaitForSingleObject($pi.hProcess, [uint32]::MaxValue)
  $code = [uint32]0
  [void][Infra.Native]::GetExitCodeProcess($pi.hProcess, [ref]$code)
  Write-Output "EXIT=$code"
}
[void][Infra.Native]::CloseHandle($pi.hThread)
[void][Infra.Native]::CloseHandle($pi.hProcess)
exit 0
