# Uses the same Windows APIs as Codex's pinned os_info 3.14.0 dependency.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiCodexWireNativeInfo {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct VersionInfo {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
        public ushort ServicePackMajor, ServicePackMinor, SuiteMask;
        public byte ProductType, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct SystemInfo {
        public ushort Architecture, Reserved;
        public uint PageSize;
        public IntPtr MinimumAddress, MaximumAddress;
        public UIntPtr ActiveProcessorMask;
        public uint ProcessorCount, ProcessorType, AllocationGranularity;
        public ushort ProcessorLevel, ProcessorRevision;
    }
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
    public static extern int RtlGetVersion(ref VersionInfo info);
    [DllImport("kernel32.dll")]
    public static extern void GetNativeSystemInfo(out SystemInfo info);
}
'@
$version = New-Object PiCodexWireNativeInfo+VersionInfo
$version.Size = [Runtime.InteropServices.Marshal]::SizeOf($version)
$versionText = 'unknown'
if ([PiCodexWireNativeInfo]::RtlGetVersion([ref]$version) -eq 0) {
    $versionText = '{0}.{1}.{2}' -f $version.Major, $version.Minor, $version.Build
}
$system = New-Object PiCodexWireNativeInfo+SystemInfo
[PiCodexWireNativeInfo]::GetNativeSystemInfo([ref]$system)
$names = @{ 9 = 'x86_64'; 6 = 'ia64'; 5 = 'arm'; 12 = 'aarch64'; 0 = 'i386' }
$architecture = $names[[int]$system.Architecture]
if (-not $architecture) { $architecture = 'unknown' }
@{ osType = 'Windows'; version = $versionText; architecture = $architecture } | ConvertTo-Json -Compress
