$log = "C:\Repos\ProjectLoneWolfLauncher\unpack-staging.log"
"[START $(Get-Date -Format 'HH:mm:ss')]" | Out-File $log -Encoding utf8
try {
    & "C:\Repos\ProjectLoneWolfLauncher\src\powershell\Unpack-Staging.ps1" `
        -ShareRoot "C:\Repos\ProjectLoneWolfLauncher" `
        -WorkflowType AMD64 2>&1 | Tee-Object -FilePath $log -Append
    "[DONE $(Get-Date -Format 'HH:mm:ss')]" | Add-Content $log
} catch {
    "[ERROR $(Get-Date -Format 'HH:mm:ss')] $_" | Add-Content $log
}
