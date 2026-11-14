# OpenCode Chrome Extension - Native Messaging Host Installer

param(
    [string]$InstallPath = "$env:LOCALAPPDATA\OpenCodeChrome",
    [string]$ExtensionId = "jchffojdjnhpmdgnifkhpgmgokbidobi",
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Continue"

# NSIS nsExec는 시스템 코드 페이지(CP949)로 출력을 읽으므로 UTF-8 강제 설정 제거
# (강제 설정 시 NSIS 설치 창에서 한글이 깨짐)

# 설치 트랜스크립트 (디버그용)
$installLogDir = "$env:LOCALAPPDATA\OpenCodeChrome\logs"
if (-not (Test-Path $installLogDir)) { New-Item -ItemType Directory -Path $installLogDir -Force | Out-Null }
Start-Transcript -Path "$installLogDir\install.log" -Append -Force

# 수동으로 Node.js를 설치한 직후 PowerShell을 재시작하지 않아도 되도록
# 레지스트리에서 최신 PATH를 강제로 읽어온다.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

# Chrome이 Native Messaging Host를 띄울 때 쓰는 프로세스 환경에는
# 사용자의 PATH가 그대로 반영되지 않는 경우가 많다 (Node 설치 후 PATH가
# 갱신돼도 이미 떠 있는 explorer/Chrome 세션은 못 봄). 그래서 host.bat에
# "node"를 그대로 쓰면 "Error when writing to Native Messaging host: -101"
# (프로세스가 즉시 종료)로 이어진다. 설치 시점에 node.exe의 절대 경로를
# 찾아 host.bat에 직접 박아 넣어 PATH 의존성을 없앤다.
function Find-NodeExecutable {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }

    try {
        $installDir = Get-ItemPropertyValue -Path "HKLM:\SOFTWARE\Node.js" -Name "InstallPath" -ErrorAction Stop
        $exe = Join-Path $installDir "node.exe"
        if (Test-Path $exe) { return $exe }
    } catch {}

    return $null
}

# ─── opencode 탐색 (host.js의 findWindowsOpenCode / findWslOpenCode와 같은 순서) ───
# 설치 시점에 Windows·WSL 양쪽을 실제로 확인해, WSL 네트워크 설정 안내와 .mcp.json 설정을
# 실제 상태에 맞춘다.
function Find-WindowsOpenCode {
    # $env:Path는 위에서 레지스트리 값으로 새로 읽었다(= host.js의 registry-path 단계)
    $cmd = Get-Command opencode -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }

    $scoopShims = if ($env:SCOOP) { Join-Path $env:SCOOP "shims" } else { Join-Path $env:USERPROFILE "scoop\shims" }
    $pnpmHome = if ($env:PNPM_HOME) { $env:PNPM_HOME } else { Join-Path $env:LOCALAPPDATA "pnpm" }
    $programData = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
    $dirs = @(
        (Join-Path $env:APPDATA "npm"),
        (Join-Path $env:USERPROFILE ".opencode\bin"),
        (Join-Path $env:USERPROFILE ".bun\bin"),
        $scoopShims,
        $pnpmHome,
        $env:NVM_SYMLINK,
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"),
        (Join-Path $programData "chocolatey\bin")
    ) | Where-Object { $_ }
    foreach ($dir in $dirs) {
        foreach ($name in @("opencode.exe", "opencode.cmd", "opencode.bat")) {
            $candidate = Join-Path $dir $name
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

# wsl.exe를 시간 제한을 두고 실행해 stdout(UTF-8)과 종료 코드를 돌려준다.
# 인자는 리눅스 셸이 그대로 해석하도록 원문 문자열로 넘긴다(PowerShell 5.1의 네이티브 인자
# 전달은 안쪽 큰따옴표를 이스케이프하지 않아 `bash -c '. "$HOME/..."'` 형태가 깨진다).
function Invoke-WslCommand {
    param([string]$Arguments, [int]$TimeoutMs = 15000)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "wsl.exe"
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return @{ ExitCode = $null; Stdout = ""; Error = $_.Exception.Message }
    }
    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $null = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill() } catch {}
        return @{ ExitCode = $null; Stdout = ""; Error = "timeout" }
    }
    return @{ ExitCode = $p.ExitCode; Stdout = $stdoutTask.Result; Error = $null }
}

function Find-WslOpenCode {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $null }
    $strategies = @(
        "bash -c 'test -x `"`$HOME/.opencode/bin/opencode`" && echo `"`$HOME/.opencode/bin/opencode`"'",
        "bash -c '. `"`$HOME/.nvm/nvm.sh`" 2>/dev/null; which opencode 2>/dev/null'",
        "bash -ilc 'which opencode 2>/dev/null'"
    )
    foreach ($wslArgs in $strategies) {
        $r = Invoke-WslCommand -Arguments $wslArgs
        # wsl.exe 자체 오류(배포판 없음 등)는 종료 코드 -1이고 메시지가 stdout에 UTF-16LE로 나온다.
        # 이 경우 다른 전략도 같은 결과이므로 끝낸다.
        # 시간 초과도 끝낸다: WSL이 없는 PC의 wsl.exe 스텁에서 전략마다 15초씩 기다리지 않도록.
        if ($r.ExitCode -eq -1 -or $r.Error) { return $null }
        if ($r.ExitCode -ne 0) { continue }
        $last = ($r.Stdout -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -Last 1
        if ($last -and $last.StartsWith("/")) { return $last }
    }
    return $null
}

function Set-ProxyCredentials {
    param([string]$ProxyUri, [System.Net.ICredentials]$Credentials)
    $proxy = New-Object System.Net.WebProxy($ProxyUri)
    $proxy.Credentials = $Credentials
    [System.Net.WebRequest]::DefaultWebProxy = $proxy
}

function Configure-Proxy {
    # 환경변수에 프록시 URL이 있으면 명시적 WebProxy 객체 생성
    # GetSystemWebProxy()는 WinINet(IE) 설정을 읽는데 실제 프록시 URL과 다를 수 있어
    # 명시적 URL이 NTLM/Kerberos 자격증명 전달에 더 확실함
    $proxyUri = if ($env:https_proxy) { $env:https_proxy } elseif ($env:http_proxy) { $env:http_proxy } else { $null }
    if ($proxyUri) {
        $webProxy = New-Object System.Net.WebProxy($proxyUri)
        $webProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
        [System.Net.WebRequest]::DefaultWebProxy = $webProxy
        Write-Host "  명시적 프록시 설정: $proxyUri + Windows 자격증명" -ForegroundColor Gray
    } else {
        # 환경변수 없으면 WinINet 시스템 프록시 fallback
        $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $systemProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
        [System.Net.WebRequest]::DefaultWebProxy = $systemProxy
        Write-Host "  시스템 프록시 + Windows 자격증명 적용" -ForegroundColor Gray
    }
}

function Apply-ProxyEnvVars {
    param([string]$ProxyUri)
    # curl, npm, git, wget 등 http_proxy 환경 변수를 읽는 도구에 적용
    $env:http_proxy  = $ProxyUri
    $env:https_proxy = $ProxyUri
    $env:HTTP_PROXY  = $ProxyUri
    $env:HTTPS_PROXY = $ProxyUri
}

function Apply-NpmProxy {
    param([string]$ProxyUri)
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) {
        npm config set proxy       $ProxyUri 2>&1 | Out-Null
        npm config set https-proxy $ProxyUri 2>&1 | Out-Null
        Write-Host "  npm proxy 설정 완료: $ProxyUri" -ForegroundColor Gray
    }
}

function Read-HostSafe {
    param([string]$Prompt, [switch]$AsSecureString)
    # Start-Transcript 활성화 중 Read-Host 가 UnauthorizedAccessException을 던지는
    # PowerShell 5.1 버그 우회 — Console.ReadLine() 으로 fallback
    try {
        if ($AsSecureString) {
            return Read-Host $Prompt -AsSecureString
        }
        return Read-Host $Prompt
    } catch {
        Write-Host $Prompt -NoNewline
        if ($AsSecureString) {
            # 보안 입력: 문자를 숨기고 SecureString 반환
            $ss = New-Object System.Security.SecureString
            while ($true) {
                $key = [System.Console]::ReadKey($true)
                if ($key.Key -eq 'Enter') { Write-Host ""; break }
                if ($key.Key -eq 'Backspace') {
                    if ($ss.Length -gt 0) { $ss.RemoveAt($ss.Length - 1); Write-Host "`b `b" -NoNewline }
                } else {
                    $ss.AppendChar($key.KeyChar); Write-Host "*" -NoNewline
                }
            }
            return $ss
        }
        $line = [System.Console]::ReadLine()
        return $line
    }
}

function Configure-ProxyManual {
    Write-Host ""
    Write-Host "  프록시 인증이 필요합니다. 프록시 정보를 입력하세요." -ForegroundColor Yellow
    Write-Host "  (프록시를 사용하지 않으면 Enter를 누르세요)" -ForegroundColor Gray
    $proxyUri = Read-HostSafe "  프록시 주소 (예: http://proxy.company.com:8080): "
    if ([string]::IsNullOrWhiteSpace($proxyUri)) { return $false }

    $proxyUser = Read-HostSafe "  프록시 사용자명 (없으면 Enter): "
    if (-not [string]::IsNullOrWhiteSpace($proxyUser)) {
        $proxyPass = Read-HostSafe "  프록시 비밀번호" -AsSecureString
        $cred = New-Object System.Net.NetworkCredential($proxyUser, $proxyPass)
        # 자격증명을 URL에 인코딩해 환경 변수에도 포함 (user:pass@host 형식)
        $plainPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($proxyPass))
        $uri = [System.Uri]$proxyUri
        $proxyUriWithCred = "$($uri.Scheme)://${proxyUser}:${plainPass}@$($uri.Host):$($uri.Port)"
        Set-ProxyCredentials -ProxyUri $proxyUri -Credentials $cred
        Apply-ProxyEnvVars -ProxyUri $proxyUriWithCred
        Apply-NpmProxy     -ProxyUri $proxyUriWithCred
    } else {
        Set-ProxyCredentials -ProxyUri $proxyUri -Credentials ([System.Net.CredentialCache]::DefaultNetworkCredentials)
        Apply-ProxyEnvVars -ProxyUri $proxyUri
        Apply-NpmProxy     -ProxyUri $proxyUri
    }
    Write-Host "  프록시 설정 완료: $proxyUri" -ForegroundColor Green
    return $true
}

function Format-Json {
    param([string]$Json)
    $indent = 0
    ($Json -split '\n' | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^[}\]]') { $indent -= 2 }
        $out = (' ' * [Math]::Max($indent, 0)) + $line
        if ($line -match '[{\[]$') { $indent += 2 }
        $out
    }) -join "`n"
}

function Merge-McpJson {
    param(
        [string]$TargetPath,
        [PSCustomObject]$McpServers
    )

    if (-not $McpServers) {
        Write-Host "  MCP 설정 없음 - SKIP ($TargetPath)" -ForegroundColor Gray
        return
    }

    $existing = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }

    if (Test-Path $TargetPath) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupPath = "$TargetPath.bak-$timestamp"
        Copy-Item $TargetPath $backupPath
        Write-Host "  백업 완료: $backupPath" -ForegroundColor Gray

        try {
            $rawContent = Get-Content $TargetPath -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace($rawContent)) {
                Write-Host "  기존 .mcp.json 비어 있음 - 초기화" -ForegroundColor Yellow
                $existing = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
            } else {
                $existing = $rawContent | ConvertFrom-Json
                if ($null -eq $existing) {
                    Write-Host "  기존 .mcp.json 파싱 결과 null - 초기화" -ForegroundColor Yellow
                    $existing = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
                } elseif (-not $existing.mcpServers) {
                    $existing | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{})
                }
            }
        } catch {
            Write-Host "  기존 .mcp.json 파싱 실패, 빈 객체로 재생성: $_" -ForegroundColor Yellow
            $existing = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
        }
    } else {
        Write-Host "  .mcp.json 없음 - 새로 생성: $TargetPath" -ForegroundColor Gray
        $dir = Split-Path $TargetPath -Parent
        if ($dir -and -not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }

    $added = 0; $skipped = 0
    $McpServers.PSObject.Properties | ForEach-Object {
        if ($existing.mcpServers.PSObject.Properties[$_.Name]) {
            Write-Host "  MCP 서버 '$($_.Name)' 이미 설치됨 - SKIP" -ForegroundColor Yellow
            $skipped++
        } else {
            $existing.mcpServers | Add-Member -NotePropertyName $_.Name -NotePropertyValue $_.Value
            Write-Host "  MCP 서버 '$($_.Name)' 추가됨" -ForegroundColor Green
            $added++
        }
    }

    $jsonStr = $existing | ConvertTo-Json -Depth 10
    Write-Host "  JSON 직렬화 길이: $($jsonStr.Length)" -ForegroundColor Gray
    $formatted = Format-Json -Json $jsonStr
    Write-Host "  Format-Json 결과 길이: $($formatted.Length)" -ForegroundColor Gray
    try {
        [System.IO.File]::WriteAllText($TargetPath, $formatted, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "  .mcp.json 저장 완료 (추가: $added, 스킵: $skipped)" -ForegroundColor Green
    } catch {
        Write-Host "  .mcp.json 저장 실패: $_ ($TargetPath)" -ForegroundColor Red
    }
}

function Install-NodeJS {
    Write-Host ""
    Write-Host "Node.js를 자동 설치합니다..." -ForegroundColor Cyan

    # 프록시 환경 대응: 시스템 프록시 + Windows 자격증명 자동 적용
    Configure-Proxy

    # 1순위: winget (Windows 10 1709+ / Windows 11 기본 탑재)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "  [winget] Node.js LTS 설치 중..." -ForegroundColor Gray
        try {
            winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -e --silent 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Node.js 설치 완료 (winget)" -ForegroundColor Green
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                            [System.Environment]::GetEnvironmentVariable("Path", "User")
                return $true
            }
            Write-Host "  winget 종료 코드: $LASTEXITCODE" -ForegroundColor Yellow
        } catch {
            Write-Host "  winget 실패: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  winget을 찾을 수 없음. MSI 직접 설치를 시도합니다." -ForegroundColor Yellow
    }

    # 2순위: nodejs.org LTS MSI 직접 다운로드 (프록시 재시도 포함)
    $downloadAttempts = @(
        @{ Label = "시스템 프록시 자동"; Configured = $true }
        @{ Label = "수동 프록시 입력";   Configured = $false }
    )

    foreach ($attempt in $downloadAttempts) {
        if (-not $attempt.Configured) {
            $ok = Configure-ProxyManual
            if (-not $ok) { break }
        }

        Write-Host "  [MSI] nodejs.org LTS 버전 정보 조회 중... ($($attempt.Label))" -ForegroundColor Gray
        try {
            $indexJson = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 30 -UseDefaultCredentials
            $lts = $indexJson | Where-Object { $_.lts -ne $false } | Select-Object -First 1
            $version = $lts.version
            $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
            $msiUrl = "https://nodejs.org/dist/$version/node-$version-$arch.msi"
            $msiPath = Join-Path $env:TEMP "node-installer.msi"

            Write-Host "  다운로드 중: Node.js $version ($arch)..." -ForegroundColor Gray
            $downloaded = $false

            # BITS 1순위: WinHTTP 스택 사용 → OS 레벨에서 NTLM/Kerberos 인증 자동 처리
            # (Invoke-WebRequest의 .NET HttpWebRequest보다 사내 프록시 통과율이 높음)
            try {
                Import-Module BitsTransfer -ErrorAction Stop
                Start-BitsTransfer -Source $msiUrl -Destination $msiPath -ErrorAction Stop
                $downloaded = $true
                Write-Host "  다운로드 완료 (BITS)" -ForegroundColor Gray
            } catch {
                Write-Host "  BITS 실패, Invoke-WebRequest 시도: $($_.Exception.Message)" -ForegroundColor Yellow
            }

            if (-not $downloaded) {
                Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -TimeoutSec 300 -UseDefaultCredentials
            }

            Write-Host "  설치 중 (자동 설치)..." -ForegroundColor Gray
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /quiet /norestart" -Wait -PassThru
            Remove-Item $msiPath -Force -ErrorAction SilentlyContinue

            if ($proc.ExitCode -eq 0) {
                Write-Host "  Node.js 설치 완료 (MSI)" -ForegroundColor Green
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                            [System.Environment]::GetEnvironmentVariable("Path", "User")
                return $true
            }
            Write-Host "  MSI 설치 실패 (ExitCode: $($proc.ExitCode))" -ForegroundColor Red
        } catch {
            Write-Host "  다운로드/설치 실패: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    return $false
}

Write-Host "=== OpenCode Chrome Extension Installer ===" -ForegroundColor Cyan

if ($PSScriptRoot) {
    $scriptDir = $PSScriptRoot
} else {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ([string]::IsNullOrEmpty($scriptDir)) {
        $scriptDir = "."
    }
}

Write-Host "Script location: $scriptDir" -ForegroundColor Gray

# ─── Private Config 읽기 및 Proxy 환경변수 주입 ──────────────────────
$privateConfigPath = Join-Path $scriptDir "config.private.json"
$privateConfig = $null

if (Test-Path $privateConfigPath) {
    try {
        $privateConfig = Get-Content $privateConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host "config.private.json 로드 완료" -ForegroundColor Gray
    } catch {
        Write-Host "config.private.json 파싱 실패 - MCP/Proxy SKIP: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "config.private.json 없음 - MCP/Proxy 설정 SKIP" -ForegroundColor Gray
}

if ($privateConfig -and $privateConfig.proxy) {
    $p = $privateConfig.proxy
    if ($p.http) {
        $env:http_proxy = $p.http;  $env:HTTP_PROXY  = $p.http
        [System.Environment]::SetEnvironmentVariable('http_proxy', $p.http,  'User')
        [System.Environment]::SetEnvironmentVariable('HTTP_PROXY',  $p.http,  'User')
    }
    if ($p.https) {
        $env:https_proxy = $p.https; $env:HTTPS_PROXY = $p.https
        [System.Environment]::SetEnvironmentVariable('https_proxy', $p.https, 'User')
        [System.Environment]::SetEnvironmentVariable('HTTPS_PROXY', $p.https, 'User')
    }
    if ($p.noProxy) {
        # NO_PROXY는 기존 항목 보존 + 신규 항목 추가 (중복 제거)
        $existingNoProxy = [System.Environment]::GetEnvironmentVariable('NO_PROXY', 'User')
        $merged = (@($existingNoProxy -split ',') + @($p.noProxy -split ',') |
                   Where-Object { $_ -match '\S' } |
                   ForEach-Object { $_.Trim() } |
                   Select-Object -Unique) -join ','
        $env:no_proxy = $merged;  $env:NO_PROXY = $merged
        [System.Environment]::SetEnvironmentVariable('no_proxy', $merged, 'User')
        [System.Environment]::SetEnvironmentVariable('NO_PROXY',  $merged, 'User')
    }
    Write-Host "Proxy 환경변수 설정 완료 (HTTP=$($p.http)) - 사용자 환경변수에 영구 저장됨" -ForegroundColor Gray

    # config.private.json은 설치 끝에 삭제되므로, 확장이 설정 화면에 보여줄 수 있게 proxy 섹션만 따로 남긴다.
    try {
        $proxyDir = Join-Path $env:LOCALAPPDATA "OpenCodeChrome"
        New-Item -ItemType Directory -Path $proxyDir -Force | Out-Null
        $proxyOut = [ordered]@{
            http    = [string]$p.http
            https   = [string]$p.https
            noProxy = [string]$p.noProxy
        }
        $json = $proxyOut | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText((Join-Path $proxyDir "proxy.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Host "proxy.json 저장 실패 (무시): $_" -ForegroundColor Yellow
    }
}

$sourceHost = Join-Path $scriptDir "host.js"
$sourceManifest = Join-Path $scriptDir "manifest.json"

if (-not (Test-Path $sourceHost)) {
    Write-Host "ERROR: host.js not found" -ForegroundColor Red
    Write-Host "   This script must be run from the native-host folder" -ForegroundColor Yellow
    exit 1
}

$nativeHostDir = Join-Path $InstallPath "native-host"

Write-Host "1. Installing files..." -ForegroundColor Gray

if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}

if (-not (Test-Path $nativeHostDir)) {
    New-Item -ItemType Directory -Path $nativeHostDir -Force | Out-Null
}

try {
    $destHostJs = Join-Path $nativeHostDir (Split-Path $sourceHost -Leaf)
    if ((Resolve-Path $sourceHost -ErrorAction SilentlyContinue).Path -ne (Resolve-Path $destHostJs -ErrorAction SilentlyContinue).Path) {
        Copy-Item -Path $sourceHost -Destination $nativeHostDir -Force
    }
    Write-Host "   host.js installed" -ForegroundColor Gray
} catch {
    Write-Host "ERROR: Failed to copy host.js - $($_.Exception.Message)" -ForegroundColor Red
}

$nodePath = Find-NodeExecutable
if (-not $nodePath) {
    Write-Host "Node.js(node.exe)를 찾을 수 없습니다." -ForegroundColor Yellow
    $installed = Install-NodeJS
    if ($installed) {
        $nodePath = Find-NodeExecutable
    }
    if (-not $nodePath) {
        Write-Host "ERROR: Node.js 자동 설치에 실패했습니다." -ForegroundColor Red
        Write-Host "   https://nodejs.org/ 에서 수동으로 설치한 뒤 이 스크립트를 다시 실행하세요." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "   Node.js 발견: $nodePath" -ForegroundColor Gray

$sourcePackageJson = Join-Path $scriptDir "package.json"
if (Test-Path $sourcePackageJson) {
    try {
        Copy-Item -Path $sourcePackageJson -Destination $nativeHostDir -Force
        Write-Host "   package.json installed" -ForegroundColor Gray
    } catch {
        Write-Host "ERROR: Failed to copy package.json - $($_.Exception.Message)" -ForegroundColor Red
    }
}

$hostBatPath = Join-Path $nativeHostDir "host.bat"
$hostJsPath = Join-Path $nativeHostDir "host.js"
$hostBatContent = "@echo off`r`n`"$nodePath`" `"$hostJsPath`" %*`r`n"
[System.IO.File]::WriteAllText($hostBatPath, $hostBatContent, (New-Object System.Text.UTF8Encoding $false))
Write-Host "   host.bat generated (node: $nodePath)" -ForegroundColor Gray

$manifestPath = Join-Path $nativeHostDir "manifest.json"
$manifestContent = @{
    name            = "com.opencode.chrome"
    description     = "OpenCode Chrome Extension Native Messaging Host"
    path            = $hostBatPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($manifestPath, $manifestContent, (New-Object System.Text.UTF8Encoding $false))
Write-Host "   manifest.json installed (path: $hostBatPath)" -ForegroundColor Gray

Write-Host "2. Registering in registry..." -ForegroundColor Gray

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.opencode.chrome"
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}

try {
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath
    Write-Host "   Registry registered" -ForegroundColor Gray
} catch {
    Write-Host "ERROR: Failed to register registry - $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "INSTALL COMPLETE!" -ForegroundColor Green
Write-Host "  Install location: $nativeHostDir" -ForegroundColor Gray
Write-Host "  Manifest: $manifestPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Please reload Chrome extension." -ForegroundColor Yellow

# npm dependencies install (번들된 node_modules 사용 시 -SkipNpmInstall으로 건너뜀)
if (-not $SkipNpmInstall) {
    Write-Host ""
    Write-Host "Installing npm dependencies..." -ForegroundColor Gray
    $npmPath = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmPath) {
        try {
            Push-Location $nativeHostDir
            npm install
            Pop-Location
            Write-Host "  ✓ npm install complete" -ForegroundColor Green
        } catch {
            Write-Host "  ⚠ npm install failed. Please run manually:" -ForegroundColor Yellow
            Write-Host "    cd $nativeHostDir" -ForegroundColor Gray
            Write-Host "    npm install" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ⚠ npm not found. Please install Node.js first:" -ForegroundColor Yellow
        Write-Host "    https://nodejs.org/" -ForegroundColor Gray
        Write-Host "    Then run: cd $nativeHostDir && npm install" -ForegroundColor Gray
    }
}

# opencode 위치 확인 (Windows / WSL 양쪽을 실제로 확인)
Write-Host ""
Write-Host "Looking for opencode..." -ForegroundColor Gray
$winOpenCode = Find-WindowsOpenCode
$wslOpenCode = Find-WslOpenCode
if ($winOpenCode) { Write-Host "  Windows: $winOpenCode" -ForegroundColor Gray } else { Write-Host "  Windows: not found" -ForegroundColor Gray }
if ($wslOpenCode) { Write-Host "  WSL:     $wslOpenCode" -ForegroundColor Gray } else { Write-Host "  WSL:     not found" -ForegroundColor Gray }

# WSL2 networking configuration check
Write-Host ""
Write-Host "Checking WSL2 networking configuration..." -ForegroundColor Gray

$wslConfigPath = "$env:USERPROFILE\.wslconfig"
$wslConfigContent = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "" }

# mirrored 설정은 WSL의 opencode에 연결할 때만 필요하다. Windows에만 opencode가 있으면
# WSL을 재시작(작업 중인 WSL 세션 종료)하는 설정을 권하지 않는다. 양쪽 모두 없으면
# 나중에 WSL에 설치할 수 있으므로 기존처럼 안내한다.
if ($winOpenCode -and -not $wslOpenCode) {
    Write-Host " Using Windows opencode - WSL2 networking setup skipped." -ForegroundColor Green
    Write-Host " (If you install opencode in WSL later, re-run this installer.)" -ForegroundColor Gray
} elseif ($wslConfigContent -notmatch "networkingMode\s*=\s*mirrored") {
    Write-Host ""
    Write-Host "─────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host " WSL OpenCode Integration Setup" -ForegroundColor Cyan
    Write-Host "─────────────────────────────────────────────────" -ForegroundColor Cyan
    if ($wslOpenCode) {
        Write-Host " OpenCode was found in WSL. To use WSL opencode,"
    } else {
        Write-Host " OpenCode was not found on Windows or in WSL. To use WSL opencode,"
    }
    Write-Host " WSL2 Mirrored Networking configuration is required."
    Write-Host ""
    Write-Host " Config file: $wslConfigPath"
    Write-Host ""
    Write-Host " ⚠️  WARNING: All running WSL sessions will be closed." -ForegroundColor Yellow
    Write-Host "     Please save your work first." -ForegroundColor Yellow
    Write-Host "─────────────────────────────────────────────────" -ForegroundColor Cyan
    $confirm = Read-HostSafe " Auto-configure and restart WSL? [Y/n]: "

    if ($confirm -ne 'n' -and $confirm -ne 'N') {
        # Add networkingMode=mirrored to [wsl2] section
        if ($wslConfigContent -match "\[wsl2\]") {
            $wslConfigContent = $wslConfigContent -replace "(\[wsl2\])", "`$1`nnetworkingMode=mirrored"
        } else {
            $wslConfigContent += "`n[wsl2]`nnetworkingMode=mirrored`n"
        }
        Set-Content -Path $wslConfigPath -Value $wslConfigContent
        Write-Host " .wslconfig updated successfully." -ForegroundColor Green
        Write-Host " Restarting WSL (wsl.exe --shutdown)..." -ForegroundColor Green
        wsl.exe --shutdown
        Write-Host " WSL restarted. You can now use WSL opencode." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host " Manual setup:" -ForegroundColor Cyan
        Write-Host "  1. Open or create the file:"
        Write-Host "     $wslConfigPath"
        Write-Host "  2. Add the following content:"
        Write-Host "       [wsl2]"
        Write-Host "       networkingMode=mirrored"
        Write-Host "  3. Close all WSL windows and run in PowerShell:"
        Write-Host "       wsl.exe --shutdown"
        Write-Host "  4. Open WSL again to apply the settings."
    }
} else {
    Write-Host " WSL2 Mirrored Networking already configured." -ForegroundColor Green
}

# ─── .mcp.json MCP 설정 ──────────────────────────────────────────────
if ($privateConfig -and $privateConfig.mcpServers) {
    Write-Host ""
    Write-Host "MCP 설정 중..." -ForegroundColor Cyan

    # [1] Windows %USERPROFILE%\.mcp.json
    $winMcpJson = "$env:USERPROFILE\.mcp.json"
    Write-Host "  Windows .mcp.json 설정: $winMcpJson" -ForegroundColor Gray
    Merge-McpJson -TargetPath $winMcpJson -McpServers $privateConfig.mcpServers

    # [2] WSL2 ~/.mcp.json
    try {
        # 위에서 host.js와 같은 3가지 전략으로 찾은 결과를 쓴다
        if ($wslOpenCode) {
            # wsl --list --quiet는 UTF-16LE 출력으로 distro명 깨짐 → WSL 내부 env var 사용
            $defaultDistro = (wsl.exe bash -c 'echo $WSL_DISTRO_NAME' 2>&1).Trim()
            $wslHome = (wsl.exe bash -c 'echo $HOME' 2>&1).Trim()
            if ($defaultDistro -and $wslHome) {
                # Join-Path는 UNC 경로($포함)에서 오류 발생 → 직접 문자열 결합
                $wslMcpJson = "\\wsl$\$defaultDistro" + $wslHome.Replace('/', '\') + "\.mcp.json"
                Write-Host "  WSL2 .mcp.json ($defaultDistro): $wslMcpJson" -ForegroundColor Gray
                Merge-McpJson -TargetPath $wslMcpJson -McpServers $privateConfig.mcpServers
            } else {
                Write-Host "  WSL2 distro/home 감지 실패 - SKIP" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  WSL2에 opencode 없음 - WSL2 SKIP" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  WSL2 확인 실패: $_" -ForegroundColor Yellow
    }

    Write-Host "MCP 설정 완료!" -ForegroundColor Green
}

# 보안 정리: privateConfig가 로드됐으면 항상 삭제 (MCP 유무와 무관)
if ($privateConfig) {
    Remove-Item $privateConfigPath -Force -ErrorAction SilentlyContinue
    Write-Host "config.private.json 삭제 완료 (보안 정리)" -ForegroundColor Gray
}

# wsl.exe 등 외부 명령의 $LASTEXITCODE가 NSIS로 누출되지 않도록 명시적으로 종료
Stop-Transcript
exit 0