; Particle CLI installer script

;--------------------------------
; General

; Name and file
!define PRODUCT_NAME "Particle CLI"
!define SHORT_NAME "ParticleCLI"
Name "${PRODUCT_NAME}"
OutFile "ParticleCLISetup.exe"
!define COMPANY_NAME "Particle Industries, Inc"
!define MUI_ICON "assets\particle.ico"

; Installation directory
InstallDir "$LOCALAPPDATA\particle"
!define BINDIR "$INSTDIR\bin"


; CLI Executable
!define EXE "particle.exe"

; Don't request admin privileges
RequestExecutionLevel user

; Show command line with details of the installation
ShowInstDetails show

; Registry Entry for environment
; All users:
;!define Environ 'HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"'
; Current user only:
!define Environ 'HKCU "Environment"'

; Registry entry for uninstaller
!define UNINSTALL_REG 'HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SHORT_NAME}"'

; Text to display when the installation is done
CompletedText 'Run "particle login" in the command line to start using the Particle CLI'


;--------------------------------
; Dependencies

; Add JSON and download plugins
; Modern UI
!include "MUI2.nsh"
; Architecture detection
!include "x64.nsh"
!include "TextFunc.nsh"
!include "LogicLib.nsh"

!include "utils.nsh"

; Don't show a certain operation in the details
!macro EchoOff
	SetDetailsPrint none
!macroend
!macro EchoOn
	SetDetailsPrint both
!macroend
!define EchoOff "!insertmacro EchoOff"
!define EchoOn "!insertmacro EchoOn"

;--------------------------------
; Installer pages

; Welcome page
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\particle.bmp"
!define MUI_WELCOMEPAGE_TITLE "Install the ${PRODUCT_NAME}"
!define /file MUI_WELCOMEPAGE_TEXT "welcome.txt"

!insertmacro MUI_PAGE_WELCOME

; Open source licenses
!insertmacro MUI_PAGE_LICENSE "licenses.txt"

; Installation details page
!insertmacro MUI_PAGE_INSTFILES

; Finish page
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Enable automatic updates"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION EnableAutoUpdates
!insertmacro MUI_PAGE_FINISH

; Uninstall confirm page
!insertmacro MUI_UNPAGE_CONFIRM
; Uninstallation details page
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Installer Sections

Section "CLI" CLI_SECTION
	SectionIn 1 3
    SetOutPath $INSTDIR
	Call CopyExecutables
	Call DisableAutoUpdates
	Call AddCLIToPath
SectionEnd

Section "-Create uninstaller"
    WriteRegStr ${UNINSTALL_REG} "DisplayName" "${PRODUCT_NAME}"
    WriteRegStr ${UNINSTALL_REG} "Publisher" "${COMPANY_NAME}"
    WriteRegStr ${UNINSTALL_REG} "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegDWORD ${UNINSTALL_REG} "NoModify" 1
    WriteRegDWORD ${UNINSTALL_REG} "NoRepair" 1

	WriteUninstaller "$INSTDIR\Uninstall.exe"
	DetailPrint ""
SectionEnd


;--------------------------------
; Uninstaller Sections

Section "Uninstall"
	RMDir /r /REBOOTOK "$INSTDIR"

    DeleteRegKey ${UNINSTALL_REG}

	Push "${BINDIR}"
	Call un.RemoveFromPath
SectionEnd


Function CopyExecutables
	CreateDirectory "${BINDIR}"
	File "/oname=${BINDIR}\${EXE}" "..\..\build\particle-cli-win-x64.exe"
FunctionEnd


Function EnableAutoUpdates
    nsExec::ExecToLog "${BINDIR}\${EXE} update-cli --enable-updates"
FunctionEnd

Function DisableAutoUpdates
    nsExec::ExecToLog "${BINDIR}\${EXE} update-cli --disable-updates"
FunctionEnd

Function AddCLIToPath
	DetailPrint "Adding CLI to path"
	Push "${BINDIR}"
	Call AddToPath
FunctionEnd

