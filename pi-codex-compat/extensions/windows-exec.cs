using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

// Own the job before starting the shell. A taskkill process-tree snapshot
// alone can miss a descendant created while the shell is being terminated.
internal static class WindowsExec
{
    private const uint KillOnClose = 0x2000;
    private const int ExtendedLimits = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong Reads, Writes, Other, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static void SetLimits(IntPtr job, uint flags)
    {
        var limits = new JobLimits();
        limits.Basic.Flags = flags;
        if (!SetInformationJobObject(job, ExtendedLimits, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(c => Char.IsWhiteSpace(c) || c == '"')) return value;
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            text.Append(c);
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Main(string[] args)
    {
        if (args.Length < 3) return 127;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            SetLimits(job, KillOnClose);
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var arguments = args.Skip(3);
            var start = new ProcessStartInfo(args[2],
                String.Join(" ", args[1] == "verbatim" ? arguments : arguments.Select(Quote)))
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };
            // Inherit the original handles, without .NET text decoding or
            // redirection. This includes stdin used by legacy WSL bash.
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                int code = child.ExitCode;
                // A normal exit may deliberately leave a background process.
                // Cancellation or owner death instead closes the armed job.
                SetLimits(job, 0);
                return code;
            }
        }
        catch (Exception error)
        {
            var native = error as Win32Exception;
            string code = native != null && (native.NativeErrorCode == 2 || native.NativeErrorCode == 3)
                ? "ENOENT: " : native != null && native.NativeErrorCode == 5 ? "EACCES: " : "";
            File.WriteAllText(args[0], code + error.Message, new UTF8Encoding(false));
            return 127;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
