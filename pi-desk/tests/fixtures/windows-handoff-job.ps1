param([ValidateSet('Run','Probe')][string]$Mode, [string]$JobName, [string]$CommandFile, [string]$Pids)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DeskFixtureJob {
    [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create(string name) {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception();
        ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
            int error = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
        }
        return job;
    }
    public static uint Active(IntPtr job) {
        Accounting value;
        if (!QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
        return value.ActiveProcesses;
    }
    public static bool Member(string name, int pid) {
        IntPtr job = OpenJobObject(4, false, name);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try {
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) throw new Win32Exception();
            try {
                bool member;
                if (!IsProcessInJob(process, job, out member)) throw new Win32Exception();
                return member;
            } finally { CloseHandle(process); }
        } finally { CloseHandle(job); }
    }
}
'@ | Out-Null
if ($Mode -eq 'Probe') {
    $members = @($Pids.Split(',') | ForEach-Object { [int]$id = $_; @{ pid = $id; member = [DeskFixtureJob]::Member($JobName, $id) } })
    $members | ConvertTo-Json -Compress
    exit
}
$command = Get-Content -LiteralPath $CommandFile -Raw | ConvertFrom-Json
$job = [DeskFixtureJob]::Create($JobName)
$assigned = $false
try {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $command.node
    $start.Arguments = $command.arguments
    $start.WorkingDirectory = $command.cwd
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables['DESK_HANDOFF_JOB_NAME'] = $JobName
    $start.EnvironmentVariables['DESK_HANDOFF_JOB_PROOF'] = $command.proof
    $process = [System.Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not [DeskFixtureJob]::AssignProcessToJobObject($job, $process.Handle)) { throw (New-Object System.ComponentModel.Win32Exception) }
    $assigned = $true
    # The tiny Node runner cannot launch a test or actor before this admission marker.
    [System.IO.File]::WriteAllText($command.admission, 'assigned')
    if (-not $process.WaitForExit(240000)) { throw 'Owned Job fixture timed out.' }
    [System.IO.File]::WriteAllText($command.stdout, $stdout.GetAwaiter().GetResult())
    [System.IO.File]::WriteAllText($command.stderr, $stderr.GetAwaiter().GetResult())
    if ($process.ExitCode -ne 0) { throw "Owned Job fixture exited $($process.ExitCode)." }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DeskFixtureJob]::Active($job) -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
    if ([DeskFixtureJob]::Active($job) -ne 0) { throw 'Owned fixture processes did not close gracefully.' }
    @{ killOnClose = $true; admission = 'assigned-before-tests'; activeAfter = 0; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
} finally {
    # This handle owns only synthetic test processes; closing it also bounds failed fixtures.
    [DeskFixtureJob]::CloseHandle($job) | Out-Null
    if (-not $assigned -and $process -and -not $process.HasExited) { $process.Kill() }
}
