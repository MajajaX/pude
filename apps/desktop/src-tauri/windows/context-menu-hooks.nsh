!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Directory\shell\pude" "" "Open with pude"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\pude" "Icon" "$INSTDIR\pude.exe,0"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\pude\command" "" '$\"$INSTDIR\pude.exe$\" $\"%1$\"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\pude" "" "Open with pude"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\pude" "Icon" "$INSTDIR\pude.exe,0"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\pude\command" "" '$\"$INSTDIR\pude.exe$\" $\"%V$\"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\pude"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\pude"
!macroend
