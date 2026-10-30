$ErrorActionPreference = 'Stop'
$stream = $null
try {
    $targetPath = [Environment]::GetEnvironmentVariable('BILLING_SCANNER_LOCK_PATH')
    $mode = [Environment]::GetEnvironmentVariable('BILLING_SCANNER_LOCK_MODE')
    if ([String]::IsNullOrWhiteSpace($targetPath)) { exit 72 }
    if ($mode -eq 'state') {
        # This file is in the private LOCAL state directory, never on the scanner share.
        $stream = [IO.File]::Open($targetPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } elseif ($mode -eq 'read') {
        $attributes = [IO.File]::GetAttributes($targetPath)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 72 }
        # Existing writers cause this open to fail; this handle also prevents new writers.
        $stream = [IO.File]::Open($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    } else { exit 72 }
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
} catch {
    # Never print the exception: it can contain a private path or scanner filename.
    exit 71
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
