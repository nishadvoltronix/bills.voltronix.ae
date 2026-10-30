$ErrorActionPreference = 'Stop'
try {
    $targetPath = [Environment]::GetEnvironmentVariable('BILLING_SCANNER_STATE_DIRECTORY')
    if ([String]::IsNullOrWhiteSpace($targetPath)) { exit 72 }
    $item = Get-Item -LiteralPath $targetPath -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 72 }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $existing = Get-Acl -LiteralPath $targetPath
    $rules = @($existing.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($existing.AreAccessRulesProtected -and $rules.Count -eq 1 -and
        $rules[0].IdentityReference -eq $identity -and
        $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        $rules[0].InheritanceFlags -eq ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)) {
        # Do not propagate unchanged ACLs over a lock held by another process.
        exit 0
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $targetPath -AclObject $acl
} catch {
    exit 71
}
