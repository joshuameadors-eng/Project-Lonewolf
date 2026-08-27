; Not used by the public installer. LoneWolf-Launcher-Setup.exe is the
; styled bootstrapper (installer/). It copies portable LoneWolf-Launcher.exe
; to a stable path and creates desktop/Start Menu shortcuts.
; Do not ship NSIS as Setup: NSIS uninstall-before-reinstall deletes those .lnk files.

!macro customHeader
  RequestExecutionLevel user
!macroend
