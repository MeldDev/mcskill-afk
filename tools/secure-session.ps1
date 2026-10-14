param([string]$Path = 'session.json')
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path
$old = Get-Acl -LiteralPath $resolved
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = New-Object System.Security.Principal.NTAccount($old.Owner)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($identity in @($current, $owner, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $allow)))
}
Set-Acl -LiteralPath $resolved -AclObject $acl
Write-Output 'Session ACL restricted to owner, current user, SYSTEM and Administrators.'
