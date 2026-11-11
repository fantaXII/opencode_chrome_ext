# Changelog

# [2.18.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.17.0...v2.18.0) (2026-11-11)


### Bug Fixes

* Chrome 북마크 관리자와 겹치던 단축키를 사용자 지정 방식으로 변경 ([4293a58](https://github.com/fantaXII/opencode_chrome_ext/commit/4293a5894a015acbbbd087474017f2c8540d3865))
* 빌드 zip에 자기 자신(webstore zip)이 포함되던 문제 수정 ([dbddc63](https://github.com/fantaXII/opencode_chrome_ext/commit/dbddc6367d319f76dd01a318090f1f1d2e781920))
* 빌드 시 npm의 Unknown env config 경고 제거 ([f0f35a0](https://github.com/fantaXII/opencode_chrome_ext/commit/f0f35a0fe8a5563cb53abc4044a645f0bcf89af5))
* 서버 강제 재시작 중 입력을 막고 재시작 중 상태 표시 ([e9280da](https://github.com/fantaXII/opencode_chrome_ext/commit/e9280daf6b49ba36c6c3bdb97899c7e3012af0d1))
* 실행 환경(WSL/Windows) 배지가 안 보이는 경우 host 조회로 보완 ([3280d9e](https://github.com/fantaXII/opencode_chrome_ext/commit/3280d9ec21736eca5671e065de76c65cf987aa12))
* 영어 설정에서 한국어로 남던 UI 문구와 프롬프트 머리말 번역 ([50b091d](https://github.com/fantaXII/opencode_chrome_ext/commit/50b091d2e6ead398da542a1aab8a89a1f7ebc29c))
* 작업 폴더 경로 칸이 좁아 전체 경로를 볼 수 없던 문제 수정 ([ac73eca](https://github.com/fantaXII/opencode_chrome_ext/commit/ac73ecace558397abfaeb3e10c5ad25993b7875e))
* 제공자 재시도·지연·중단 시 응답 스트림 처리 보강 ([018c3a9](https://github.com/fantaXII/opencode_chrome_ext/commit/018c3a9b8ca4eb1b011a513bfb24a2d04ec703c1))
* 취소/타임아웃 시 서버 세션도 abort해 hang된 tool로 인한 교착 방지 ([96d30d8](https://github.com/fantaXII/opencode_chrome_ext/commit/96d30d8d084f188ca5221d9faad103caea8825f2))
* 컨텍스트 메뉴 중복 생성으로 인한 duplicate id 오류 수정 ([011c912](https://github.com/fantaXII/opencode_chrome_ext/commit/011c912b7f053ef1d5837a578439c3dabfdfcd7c))


### Features

* 모델 선택을 최근 사용 + provider별 접기 목록으로 개편 ([cd79449](https://github.com/fantaXII/opencode_chrome_ext/commit/cd7944928db42edac85e4a6c979ea35b8ac152f4))
* 사이드패널 UI를 부드럽고 친근한 테마로 개편 ([b399d32](https://github.com/fantaXII/opencode_chrome_ext/commit/b399d3208409427f3371de995c74af01e0c9347c))
* 서버 적용 프록시를 Windows에서도 조회하고 표시·사유 안내 개선 ([1c2decb](https://github.com/fantaXII/opencode_chrome_ext/commit/1c2decbd1e77db6e8a2dc07325bbda8bbd63364b))
* 페이지 컨텍스트 선택·응답 정화·권한/질문 요청 처리 및 SSE 안정화 ([d3386cc](https://github.com/fantaXII/opencode_chrome_ext/commit/d3386cc7c53979bb7623bd86585084de827a264c))


### Performance Improvements

* 설정 패널 렌더를 서버 적용 프록시 조회와 분리 ([baeb6a7](https://github.com/fantaXII/opencode_chrome_ext/commit/baeb6a77b0317a1b0c65cbf499d95797c1628398))

# [2.17.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.16.0...v2.17.0) (2026-11-08)


### Bug Fixes

* /sessions 목록에서 빈 세션 제외하고 폴더명 표시 ([af9f4f1](https://github.com/fantaXII/opencode_chrome_ext/commit/af9f4f167bc60399dc719738c1ed9a593ccc75bc))
* 모델이 빈 응답을 반환하면 오류를 화면에 표시 ([65bbee1](https://github.com/fantaXII/opencode_chrome_ext/commit/65bbee14e2ab4b67ceb48dc5ecb9b2f6e999e8b0))


### Features

* /new, /sessions(/resume) 명령으로 이전 세션 이어가기 ([e912c46](https://github.com/fantaXII/opencode_chrome_ext/commit/e912c463293161f7baffc2a2fda7b32baca61e75))
* 슬래시 메뉴에서 이름 중간 일치 명령도 표시 ([53f773b](https://github.com/fantaXII/opencode_chrome_ext/commit/53f773be944484111e128e8a8f324bcf2ad222c6))
* 작업 디렉터리를 저장 전에 host에서 변환·검증 ([a4b6670](https://github.com/fantaXII/opencode_chrome_ext/commit/a4b667090cdf2da10e3f1eb3931581b0df78ca7b))

# [2.16.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.15.0...v2.16.0) (2026-11-07)


### Bug Fixes

* 릴리스 시 package.json 버전도 함께 올려 빌드 산출물 버전 불일치 해결 ([1e32674](https://github.com/fantaXII/opencode_chrome_ext/commit/1e32674e20cc3afc443da9d22e4684ad2058d686))
* 응답 대기 중 Service Worker 종료로 UI가 멈추는 문제 대응 ([7017f47](https://github.com/fantaXII/opencode_chrome_ext/commit/7017f47812d4b361847c2425c693b071edb4886b))


### Features

* /debug를 /ext-log로 변경하고 카탈로그·연결 실패 화면에 노출 ([2112828](https://github.com/fantaXII/opencode_chrome_ext/commit/2112828fb176c4faf7a2eeceee99fe80e734c30a))
* 서버 연결 중에는 MCP/설정 메뉴 비활성화 ([3abab57](https://github.com/fantaXII/opencode_chrome_ext/commit/3abab570355fa2e26ce44c8f75e7661200b7f3fa))
* 설정창에 서버에 실제 적용된 프록시 표시 ([028cb38](https://github.com/fantaXII/opencode_chrome_ext/commit/028cb38f0cd73a2700727c332ff88606a4d27f80))

# [2.15.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.14.0...v2.15.0) (2026-11-04)


### Features

* config.private.json 프록시를 설정에 가져오고 로딩 중 입력 차단 ([4237252](https://github.com/fantaXII/opencode_chrome_ext/commit/42372522faf911737b753bf6a47ec2d69b80e8e1))

# [2.14.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.13.0...v2.14.0) (2026-11-02)


### Bug Fixes

* package.json 버전을 2.13.0으로 동기화 ([5eb9736](https://github.com/fantaXII/opencode_chrome_ext/commit/5eb973652c3814cfd6c14c50c6a8a9b0891ef53b))


### Features

* 사이드패널 언어 선택 추가 (한국어 기본, 영어 선택) ([1dfe6ca](https://github.com/fantaXII/opencode_chrome_ext/commit/1dfe6ca691560d29b5f3780577d7340dde11b8a1))
* 설정 메뉴 정리 및 버전 표시·확장 업데이트 확인 추가 ([2130432](https://github.com/fantaXII/opencode_chrome_ext/commit/213043284d65c582fdd3bb963cfd7c63bd0894ca))

# [2.13.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.12.0...v2.13.0) (2026-11-01)


### Features

* 설정 메뉴에 프록시 설정 추가 ([1eaf659](https://github.com/fantaXII/opencode_chrome_ext/commit/1eaf659a321a2e9d73f898933503bb14177b0a69))

# [2.12.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.11.0...v2.12.0) (2026-10-29)


### Features

* native host 버전 확인 및 업데이트 안내 ([6ae3074](https://github.com/fantaXII/opencode_chrome_ext/commit/6ae3074453cc85d9258149c07c50e5d1c688d15e))
* 서버 실행 환경 배지 표시 및 auto 모드 WSL 우선으로 변경 ([74549ca](https://github.com/fantaXII/opencode_chrome_ext/commit/74549ca17a3b2becb573c04c664cd957be9451d9))

# [2.11.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.10.0...v2.11.0) (2026-10-28)


### Features

* 설정(⚙) 메뉴 추가 - 실행 환경(WSL/Windows) 우선순위 선택 ([b1048bb](https://github.com/fantaXII/opencode_chrome_ext/commit/b1048bb5e822cd5ef70de438d80af71a5b1d9591))

# [2.10.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.9.0...v2.10.0) (2026-07-30)


### Features

* OpenCode 서버 재시작 기능 추가 (소프트/하드) ([55da3df](https://github.com/fantaXII/opencode_chrome_ext/commit/55da3df29690c1cd3ee74d4e89bc087876a8d31b))
* 코드 블록 복사/구문강조 + 스트리밍 마크다운 렌더 성능 개선 ([25361f0](https://github.com/fantaXII/opencode_chrome_ext/commit/25361f0870ce6cd1349a28b232edc83290bdcfa1))

# [2.9.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.8.0...v2.9.0) (2026-07-14)


### Features

* AI 도구 호출·reasoning 진행 상황 실시간 표시 ([20dca0b](https://github.com/fantaXII/opencode_chrome_ext/commit/20dca0b59a9a2f6722309026a25726dfbcbd7ac5))

# [2.8.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.7.0...v2.8.0) (2026-07-12)


### Features

* 사이드패널 세션 히스토리 저장·복원 기능 구현 ([cf1dcbf](https://github.com/fantaXII/opencode_chrome_ext/commit/cf1dcbf229e44239c82349562d48847398381f87))

# [2.7.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.5...v2.7.0) (2026-07-12)


### Bug Fixes

* 첨부 파일 기능 리뷰 발견 버그 수정 (native-host 오류 전파, 경로 중복 제거) ([a2af88c](https://github.com/fantaXII/opencode_chrome_ext/commit/a2af88c1b0765c3f035c28020f54fff3b7d395ae))


### Features

* 사이드패널 첨부 파일(+) 버튼에 다중 파일 첨부 기능 구현 ([3178cbd](https://github.com/fantaXII/opencode_chrome_ext/commit/3178cbde5eb1be255e634851984b98e1e6a1bdc1))

## [2.6.5](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.4...v2.6.5) (2026-07-11)


### Bug Fixes

* 세션 생성 시 x-opencode-directory 헤더 누락으로 워킹 디렉토리 미적용 문제 수정 ([287e668](https://github.com/fantaXII/opencode_chrome_ext/commit/287e6684548886c536f5b081265ef3113469fc5e))

## [2.6.4](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.3...v2.6.4) (2026-07-09)


### Bug Fixes

* 작업 디렉토리 변경이 기존 세션에 반영되지 않는 문제 수정 ([90148bd](https://github.com/fantaXII/opencode_chrome_ext/commit/90148bd738b1491e0f2ddd38a6677f8fd328b706))

## [2.6.3](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.2...v2.6.3) (2026-07-06)


### Bug Fixes

* /config의 provider 필드를 모델 providerID로 잘못 해석하는 문제 수정 ([a201abe](https://github.com/fantaXII/opencode_chrome_ext/commit/a201abed71adb0e9436f52934c8e341bfc6e09b3))
* working directory 설정이 네이티브 Windows opencode 서버에서 무시되는 문제 수정 ([c8e4eb1](https://github.com/fantaXII/opencode_chrome_ext/commit/c8e4eb1774175bbcbc5f2cb35e15e7436f72d2b5))

## [2.6.2](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.1...v2.6.2) (2026-07-05)


### Bug Fixes

* 네트워크 드라이브로 매핑된 WSL 경로의 working directory 선택 오류 수정 ([48adf35](https://github.com/fantaXII/opencode_chrome_ext/commit/48adf35cd446fd74282996253d99e21351fc0504))

## [2.6.1](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.6.0...v2.6.1) (2026-07-01)


### Bug Fixes

* extensionId를 manifest.json key에서 자동 계산하도록 변경 ([33b7360](https://github.com/fantaXII/opencode_chrome_ext/commit/33b7360298abddbc1f671c15382b6b1318a1f47d))

# [2.6.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.5...v2.6.0) (2026-06-30)


### Bug Fixes

* Extension ID를 Web Store 공개키 기반 ID로 통일 ([074150d](https://github.com/fantaXII/opencode_chrome_ext/commit/074150d9454db16570e1da633c7f86c0af1036a4))


### Features

* PowerShell 및 첨부 버튼에 '준비 중' 바텀 토스트 추가 ([eeee85b](https://github.com/fantaXII/opencode_chrome_ext/commit/eeee85b2abbdf36bae219505974417953c725fe9))
* 폴더 아이콘 클릭 시 Windows 파일 탐색기로 working directory 선택 ([0cf6db4](https://github.com/fantaXII/opencode_chrome_ext/commit/0cf6db4493dcaaa8af08c1c69a909c3148609103))

## [2.5.5](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.4...v2.5.5) (2026-06-29)


### Bug Fixes

* build:all 순서 수정으로 .exe가 dist/에 포함되도록 개선 ([2829b0b](https://github.com/fantaXII/opencode_chrome_ext/commit/2829b0b4f44e3caf07de1ce4b4fa95a39cc294b0))
* 한글 경로 working dir를 URL 인코딩하여 OpenCode에 전달 ([7531ae4](https://github.com/fantaXII/opencode_chrome_ext/commit/7531ae48999187abb27054abfdb379ba29d04319))
* 한글 경로 포함 시 메시지 전송 실패 버그 수정 ([1dcd5ba](https://github.com/fantaXII/opencode_chrome_ext/commit/1dcd5ba2f583e65b05b1dd76c0c21f6850308d90))

## [2.5.4](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.3...v2.5.4) (2026-06-28)


### Bug Fixes

* .exe 옆 외부 config.private.json 자동 적용 지원 ([78cb37c](https://github.com/fantaXII/opencode_chrome_ext/commit/78cb37c5ed815514666cb5862a01b51a57511dc6))

## [2.5.3](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.2...v2.5.3) (2026-06-28)


### Bug Fixes

* debugLog race condition 수정 및 Extension ID 관리 방식 개선 ([1ea09a1](https://github.com/fantaXII/opencode_chrome_ext/commit/1ea09a171b4e694a58a447d04d52cd35144366b3))

## [2.5.2](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.1...v2.5.2) (2026-06-28)


### Bug Fixes

* release assets 글로벌 패턴 및 빌드 전 .exe 정리 수정 ([06064bb](https://github.com/fantaXII/opencode_chrome_ext/commit/06064bbb9a51e7b8bb52a98084d6984d10541a40))

## [2.5.1](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.5.0...v2.5.1) (2026-06-28)


### Bug Fixes

* build-installer .exe 출력 경로를 루트로 수정 ([3a326d1](https://github.com/fantaXII/opencode_chrome_ext/commit/3a326d1da7cd20a4662f2821c3c484b14d774a5b))

# [2.5.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.7...v2.5.0) (2026-06-28)


### Features

* Native Host 미설치 감지 및 설치 가이드 화면 추가 ([132b416](https://github.com/fantaXII/opencode_chrome_ext/commit/132b416ed877a1955ee054f68976d2ef9e230613))

## [2.4.7](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.6...v2.4.7) (2026-06-22)


### Bug Fixes

* HTTP 400 세션 만료 시 자동 복구 및 에러 본문 로깅 추가 ([3420666](https://github.com/fantaXII/opencode_chrome_ext/commit/3420666cd05dd35ebdee2d7ab5f8e3f62fa88211))

## [2.4.6](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.5...v2.4.6) (2026-06-18)


### Bug Fixes

* 모델 미설정 시 전송 실패 및 400 에러 원인 불명 문제 수정 ([5f1a8a2](https://github.com/fantaXII/opencode_chrome_ext/commit/5f1a8a2132bcfba8f9fc2f6a65f6006bcf6d31fd))

## [2.4.5](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.4...v2.4.5) (2026-06-17)


### Bug Fixes

* install.ps1 프록시 환경 Node.js 자동 설치 실패 수정 ([776343b](https://github.com/fantaXII/opencode_chrome_ext/commit/776343bf850ea917413e47b50d70687b0ebdf951))

## [2.4.4](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.3...v2.4.4) (2026-06-16)


### Bug Fixes

* opencode 서버 다운/재시작 시 자동 복구 및 레이스 컨디션 수정 ([8de5781](https://github.com/fantaXII/opencode_chrome_ext/commit/8de57814b76bb6c6ab85b23faef2cadf7dd49152))

## [2.4.3](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.2...v2.4.3) (2026-06-15)


### Bug Fixes

* SSE 응답 텍스트 누락(textParts=0, bufferLength=0) 문제 수정 ([45cd006](https://github.com/fantaXII/opencode_chrome_ext/commit/45cd00627196b0eff69bda3552817709ea6820fd))

## [2.4.2](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.1...v2.4.2) (2026-06-14)


### Bug Fixes

* WSL opencode 탐지에 공식 설치 경로(~/.opencode/bin) 직접 확인 추가 ([9848e74](https://github.com/fantaXII/opencode_chrome_ext/commit/9848e74a33616b510387bb271474c9809086e879))

## [2.4.1](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.4.0...v2.4.1) (2026-06-14)


### Bug Fixes

* .mcp.json JSON 들여쓰기 2칸으로 정규화 ([12e9497](https://github.com/fantaXII/opencode_chrome_ext/commit/12e949722b4545556f802332814977e9270cb096))
* .mcp.json 내용이 비어 있는 버그 수정 ([6674af0](https://github.com/fantaXII/opencode_chrome_ext/commit/6674af0c56a6624e42ef41edce3cd735bce34cbd))
* build:all 순서 수정 — prebuild의 dist 삭제로 installer EXE 유실 방지 ([a714a74](https://github.com/fantaXII/opencode_chrome_ext/commit/a714a74940456798e47d33d54c8d6c86155c22f9))
* config.private.json 포맷 통일 및 proxy 영구 저장, 보안 정리 버그 수정 ([2ac8189](https://github.com/fantaXII/opencode_chrome_ext/commit/2ac8189ca0082687f9204a07c329a2a9bec365a4))
* MCP 설정 대상을 .claude.json에서 .mcp.json으로 변경 ([3a694b3](https://github.com/fantaXII/opencode_chrome_ext/commit/3a694b36593d34026b18fff63c0f1e87c516804a))
* NO_PROXY 환경변수 기존 항목 보존하며 병합 (중복 제거) ([713dab4](https://github.com/fantaXII/opencode_chrome_ext/commit/713dab4dbb72bb4478faa1e516c2ec9f249d81ac))
* WSL2 distro명 깨짐 수정 및 NSIS 한글 깨짐 수정 ([8f74011](https://github.com/fantaXII/opencode_chrome_ext/commit/8f74011d0697883825c36c804d879f6bab50c8b1))
* 빈 .mcp.json 파일 읽기 시 null 체인 실패 수정 ([c674a37](https://github.com/fantaXII/opencode_chrome_ext/commit/c674a374131bc53d03a9bc833bde52c6f3fec2a3))

# [2.4.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.3.0...v2.4.0) (2026-06-14)


### Features

* NSIS 인스톨러에 MCP/Proxy private config 지원 추가 ([9a78365](https://github.com/fantaXII/opencode_chrome_ext/commit/9a78365b822aaeafe9298a26554fe51eba88e360))

# [2.3.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.2.1...v2.3.0) (2026-06-13)


### Features

* NSIS Windows 인스톨러 및 Extension ID 관리 체계 추가 ([1e5ed47](https://github.com/fantaXII/opencode_chrome_ext/commit/1e5ed472a08cad703cc20a8b2f363b5093318eed))

## [2.2.1](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.2.0...v2.2.1) (2026-06-12)


### Bug Fixes

* 미사용 scripting 권한 제거 ([e3adf0f](https://github.com/fantaXII/opencode_chrome_ext/commit/e3adf0f23430df54796b363f0dcec1ba1550b5c9))

# [2.2.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.1.4...v2.2.0) (2026-06-12)


### Features

* 아이콘 생성 스크립트 개선 및 >_ 터미널 심볼 아이콘 적용 ([5f5d7f5](https://github.com/fantaXII/opencode_chrome_ext/commit/5f5d7f5a5dcf46d27c587a4828e6a0d916e5a588))

## [2.1.4](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.1.3...v2.1.4) (2026-06-12)


### Bug Fixes

* webstore zip에서 manifest key 필드 자동 제거 ([9b3656f](https://github.com/fantaXII/opencode_chrome_ext/commit/9b3656f4893c8763af1e9b6f4d3db9a93a6871f6))

## [2.1.3](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.1.2...v2.1.3) (2026-06-12)


### Bug Fixes

* host_permissions 포트 와일드카드를 명시적 포트 목록으로 교체 ([d9d423a](https://github.com/fantaXII/opencode_chrome_ext/commit/d9d423ad0bdc19e117bef92b472e1ab5754c57f9))

## [2.1.2](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.1.1...v2.1.2) (2026-06-12)


### Bug Fixes

* --no-npm 제거로 release 시 package.json 버전 자동 범프 복구 ([16efa2c](https://github.com/fantaXII/opencode_chrome_ext/commit/16efa2c1c6cb14d5b8bfcc78046ed6e1bf80f0fe))

## [2.1.1](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.1.0...v2.1.1) (2026-06-12)


### Bug Fixes

* package.json 버전 2.1.0 동기화 및 Web Store용 zip 분리 생성 ([9671507](https://github.com/fantaXII/opencode_chrome_ext/commit/96715070f3eeedf1606f02d3726d6bc56ac298e8))

# [2.1.0](https://github.com/fantaXII/opencode_chrome_ext/compare/v2.0.0...v2.1.0) (2026-06-12)


### Bug Fixes

* MV3 SW 재시작 시 불필요한 작업 제거 및 alarms 안정화 ([ff66887](https://github.com/fantaXII/opencode_chrome_ext/commit/ff6688707ec7ae17d078d582664ae9791afaa5e9))
* resolve native messaging failures for WSL opencode ([4491c68](https://github.com/fantaXII/opencode_chrome_ext/commit/4491c68874f3d1746aadd5621b9a1b0adfd091b5))
* resolve native messaging protocol bugs and WSL path detection ([4b6bdae](https://github.com/fantaXII/opencode_chrome_ext/commit/4b6bdaefc3d27ebf6f0062e60e227c0120de6163))
* retry native messaging and WSL path detection on server connection failure ([5a26bd8](https://github.com/fantaXII/opencode_chrome_ext/commit/5a26bd8d03956705ff26d8990f5e331a11d5d381))
* return headings and paragraphs as arrays instead of strings ([b00ff20](https://github.com/fantaXII/opencode_chrome_ext/commit/b00ff20ab956e455651f497d5a293c059dbf84b9))
* SSE 세션 필터에서 메시지 ID를 세션 ID로 잘못 사용하는 문제 수정 ([48f366d](https://github.com/fantaXII/opencode_chrome_ext/commit/48f366d8ef5a381cef975fc88bbb6d9d21d2ce0c))
* SSE 타임아웃 90초 → 180초로 연장 ([6ba81b9](https://github.com/fantaXII/opencode_chrome_ext/commit/6ba81b928d7da3007e2e3b74ae5011d53d304c16))
* SW 재시작 시 탭 세션 상태 유실 문제 수정 ([94c82a4](https://github.com/fantaXII/opencode_chrome_ext/commit/94c82a4bd5b6288a75273854ddd9a28405b13529))
* SW 재시작 후 페이지 변경 알림이 누락되는 문제 수정 ([426aad5](https://github.com/fantaXII/opencode_chrome_ext/commit/426aad5c2e200ace1bb83abbd3fe5a6b5b65266f))
* Windows 경로를 WSL 경로로 자동 변환 ([358889e](https://github.com/fantaXII/opencode_chrome_ext/commit/358889eb5f6ce00680d4188f8eec0d10164ef7c1))
* Windows 콘솔에서 한글 깨짐 및 install.bat 명령 오류 수정 ([ac9fc62](https://github.com/fantaXII/opencode_chrome_ext/commit/ac9fc6202974f31f2514a1e88ed965b183c7e0e8))
* Windows에서 .CMD 파일 spawn 시 EINVAL 오류 수정 ([7355313](https://github.com/fantaXII/opencode_chrome_ext/commit/73553136733a06ccf06370a544a62aa688b537cc))
* working folder 기본 디렉토리 표시 안 되는 문제 수정 ([1843c3f](https://github.com/fantaXII/opencode_chrome_ext/commit/1843c3fdcfbff40cc84ee5d4396fc56f150d9a7f))
* working folder 표시 영역 확대 및 tooltip 수정 ([8cff81c](https://github.com/fantaXII/opencode_chrome_ext/commit/8cff81c54798f725405949f8ae6c45253c3ebc01))
* WSL opencode 탐지 실패 수정 — NVM 설치 환경 지원 ([cdbeb4f](https://github.com/fantaXII/opencode_chrome_ext/commit/cdbeb4fd2f3733fb8698ac4e827ebd180c3756e6))
* 디버그 다이얼로그 z-index 및 native host 설치 시 node.exe 절대경로 고정 ([c636a4b](https://github.com/fantaXII/opencode_chrome_ext/commit/c636a4bf7eeeaac16b6c6d0d2cc14645fc9a3f40))
* 라이트 모드에서 연결 중 오버레이 글씨가 보이지 않는 문제 수정 ([fdeeda2](https://github.com/fantaXII/opencode_chrome_ext/commit/fdeeda22b830c6eab24b34adf41260e47b9d2831))
* 서버 미연결 상태에서 잘못된 '연결됨' 표시 및 /debug 사용 불가 문제 수정 ([30c3b6b](https://github.com/fantaXII/opencode_chrome_ext/commit/30c3b6b676e712aa9696371317a825e2f6ba7978))
* 초기 화면 OpenCode 브랜딩으로 교체 및 탭 로드 버그 수정 ([387efe0](https://github.com/fantaXII/opencode_chrome_ext/commit/387efe0a9554284bc94d1b0d168eb34936196d73))
* 컨텍스트 메뉴로 보낸 텍스트 입력 후 포커스 안정성 보강 ([83a9e34](https://github.com/fantaXII/opencode_chrome_ext/commit/83a9e341d0146cbc065d1b25495e0ae64aa66462))
* 프록시 환경에서 Node.js 자동 설치 및 npm install 실패 문제 개선 ([fc65054](https://github.com/fantaXII/opencode_chrome_ext/commit/fc65054817de87a834e3f6c89c27059367ac449b))


### Features

* /model 커맨드 인자 없이 입력 시 채팅 내 모델 선택 UI 표시 ([b1f1636](https://github.com/fantaXII/opencode_chrome_ext/commit/b1f163678e86cd327303db7eb7bcf32c3e281731))
* add connecting indicator with spinner animation for server connection status ([f7c1bb0](https://github.com/fantaXII/opencode_chrome_ext/commit/f7c1bb061e2531932906949f0d5a3622ff5e6c8e))
* add right-click context menu to send selected text to side panel ([1dd7869](https://github.com/fantaXII/opencode_chrome_ext/commit/1dd7869b463275ef523ed7fa997058c35ce37059))
* add WSL opencode auto-start support via native messaging ([f34f9b7](https://github.com/fantaXII/opencode_chrome_ext/commit/f34f9b75ee9bd310a74823cb536ea0331759c8ed))
* native host 설치용 install.bat 래퍼 추가 ([252ba23](https://github.com/fantaXII/opencode_chrome_ext/commit/252ba235d3b1687f112a87b6d1d4f2973a5e7165))
* Node.js 미설치 PC에서 자동 설치 지원 (winget → MSI fallback) ([d751de6](https://github.com/fantaXII/opencode_chrome_ext/commit/d751de6a03fbd02de632a40ccbe31e0ba023b63b))
* OpenCode SSE 이벤트로 기본 디렉토리 표시 (WSL 지원) ([44b1641](https://github.com/fantaXII/opencode_chrome_ext/commit/44b164143888b6204951bd86ddb24c073c4db478))
* replace mode-select with working folder display ([09461a7](https://github.com/fantaXII/opencode_chrome_ext/commit/09461a72896f369f489c4bfbff0953f623f02198))
* Shift+Tab으로 에이전트(모드) 전환 기능 추가 ([e7c986f](https://github.com/fantaXII/opencode_chrome_ext/commit/e7c986f4a7ab5b3f842b3a7656f252fdf46e4278))
* SSE 타임아웃 개선 및 마크다운 렌더링 적용 ([2b9e9a9](https://github.com/fantaXII/opencode_chrome_ext/commit/2b9e9a9ad658655dbc6ea458d8148fdf99728e25))
* working folder UI 개편 및 헤더 정리 ([2c177d5](https://github.com/fantaXII/opencode_chrome_ext/commit/2c177d55131690808e5b7433d3fbece6be5de665))
* working folder 기본 디렉토리 표시 ([75be061](https://github.com/fantaXII/opencode_chrome_ext/commit/75be0615ad835c95c605b63c17d43d64794764f8))
* 디버그 로깅 시스템 추가 (/debug 커맨드) ([87fa999](https://github.com/fantaXII/opencode_chrome_ext/commit/87fa999d0e4eef9fe09a9fbef31dfa69f26e3f43))
* 메시지 송수신 흐름에 디버그 로그 추가 ([d41c386](https://github.com/fantaXII/opencode_chrome_ext/commit/d41c386e28280816bd05131f4433c27cf32bf43f))
* 메시지 전송 중 취소 버튼 추가 ([1922be9](https://github.com/fantaXII/opencode_chrome_ext/commit/1922be98a09ec9d71f996293ade05145baad03be))
* 사이드 패널 슬래시 커맨드(/command) 지원 추가 ([bbc4a45](https://github.com/fantaXII/opencode_chrome_ext/commit/bbc4a4552296360afc022a29dccf5e05c2c6f059))
* 사이드 패널 헤더에 MCP 서버 상태 표시 및 on/off 토글 기능 추가 ([5cb95ff](https://github.com/fantaXII/opencode_chrome_ext/commit/5cb95ff06c80a2a74fa8abc8c2b19e5f4b185fb2))
* 첫 메시지 수신 후 working folder 기본값 즉시 업데이트 ([2383d7c](https://github.com/fantaXII/opencode_chrome_ext/commit/2383d7cff2c5f0743e0c84ce1327607a830c2311))
* 페이지 변경 감지 시 사이드패널에 새 컨텍스트 안내 추가 ([a73ea74](https://github.com/fantaXII/opencode_chrome_ext/commit/a73ea74b3b4af4b5013ea3b244372ca669285c22))
