; Inner NSIS is launched already-elevated by LoneWolf-Launcher-Setup.exe
; (bootstrapper). Do not request a second UAC. Do not UPX-pack. Do not embed
; tokens. Do not silently install Node or the Windows ADK.
; .NET 8 Desktop Runtime is installed by the bootstrapper, not this inner NSIS.

!macro customHeader
  RequestExecutionLevel user
!macroend

!macro customInstall
  CreateShortCut "$DESKTOP\Project LoneWolf Launcher.lnk" "$INSTDIR\LoneWolf-Launcher.exe"
  CreateShortCut "$SMPROGRAMS\Project LoneWolf Launcher.lnk" "$INSTDIR\LoneWolf-Launcher.exe"
!macroend
