; OpenCode Chrome Extension - Native Messaging Host Installer
; Build: makensis /DEXTENSION_ID=xxx /DAPP_VERSION=2.2.1 /DOUT_FILE=/path/to/out.exe installer.nsi

!include "MUI2.nsh"

; --- 빌드 시점 주입 변수 ---
!ifndef EXTENSION_ID
  !define EXTENSION_ID "jchffojdjnhpmdgnifkhpgmgokbidobi"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "2.2.1"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\opencode-native-host-setup.exe"
!endif

; --- 기본 설정 ---
Name "OpenCode Native Messaging Host ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\OpenCodeChrome\native-host"
RequestExecutionLevel user
Unicode True
SetCompressor /SOLID lzma

; --- MUI 설정 ---
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "OpenCode Native Host 설치"
!define MUI_WELCOMEPAGE_TEXT "OpenCode Chrome 확장 프로그램의 Native Messaging Host를 설치합니다.$\r$\n$\r$\nExtension ID: ${EXTENSION_ID}$\r$\n$\r$\n계속하려면 다음을 클릭하세요."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "Korean"

; --- 설치 섹션 ---
Section "Native Host" SecMain
  SetOutPath "$INSTDIR"

  ; 핵심 파일
  File "../native-host/host.js"
  File "../native-host/package.json"
  File "../native-host/install.ps1"
  File "configure-extension-id.bat"

  ; 설치된 host 버전 기록 (확장이 get-version으로 읽어 확장 버전과 비교한다)
  FileOpen $1 "$INSTDIR\version.txt" w
  FileWrite $1 "${APP_VERSION}"
  FileClose $1

  ; node_modules 번들 (which 패키지, ~240KB)
  SetOutPath "$INSTDIR\node_modules"
  File /r "../native-host/node_modules/*"
  SetOutPath "$INSTDIR"

  ; Optional: private config (MCP 서버 + proxy — git에 없음, 빌드 시 조건부 번들)
  !ifdef HAS_PRIVATE_CONFIG
    File /oname=config.private.json "${PRIVATE_CONFIG_PATH}"
  !endif

  ; .exe와 같은 폴더에 config.private.json이 있으면 $INSTDIR로 복사 (외부 config 우선)
  IfFileExists "$EXEDIR\config.private.json" 0 +2
    CopyFiles "$EXEDIR\config.private.json" "$INSTDIR\config.private.json"

  ; install.ps1 실행: Extension ID 주입, npm install 건너뜀 (번들 사용)
  DetailPrint "Native host 설정 중... (Extension ID: ${EXTENSION_ID})"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -ExtensionId "${EXTENSION_ID}" -SkipNpmInstall'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "설치 중 오류가 발생했습니다 (종료 코드: $0).$\r$\n로그 파일: $LOCALAPPDATA\OpenCodeChrome\logs\native-host.log"
    Abort
  ${EndIf}

  ; 프로그램 추가/제거 등록
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCodeNativeHost" \
    "DisplayName" "OpenCode Native Messaging Host"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCodeNativeHost" \
    "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCodeNativeHost" \
    "Publisher" "OpenCode"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCodeNativeHost" \
    "UninstallString" "$INSTDIR\uninstall.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DetailPrint "설치 완료!"
SectionEnd

; --- 언인스톨 섹션 ---
Section "Uninstall"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenCodeNativeHost"
  RMDir /r "$INSTDIR"
SectionEnd
