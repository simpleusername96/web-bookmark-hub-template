# Web Bookmark Hub

한국어 · [English](README.md)

웹에서 여러 자료를 읽고 정리하는 사람을 위한 로컬 북마크 앱입니다. 글, 논문, 코드, 디자인 레퍼런스, 영상 링크를 한곳에 모으고 검색·폴더·태그로 다시 찾을 수 있습니다.

자신에게 필요한 도구를 만들기 위한 템플릿입니다. Codex와 함께 자료를 정리하고, 사용 목적에 맞게 앱을 수정하는 것을 전제로 만들었습니다.

## 주요 기능

- Chrome에서 현재 페이지 또는 직접 선택한 이미지를 저장합니다.
- 검색, 폴더, 태그, 자료 유형, URL 구조로 자료를 찾습니다.
- Grid, 이미지 Feed, 텍스트 중심 List로 살펴봅니다. 상세 화면에서 요약을 읽고 메모와 분류를 편집합니다.
- Codex에 링크 조사와 정리를 요청할 수 있습니다. 앱 안에서도 로컬 Codex CLI를 이용한 요약을 실행할 수 있습니다.
- 링크와 메타데이터, 선택한 미리보기를 로컬 SQLite에 보관합니다. 웹사이트 전체를 복제하는 앱은 아닙니다.

## 예제 데이터로 시작하기

**Node.js 24.19.0 이상**이 필요합니다. 앱의 npm 의존성이나 빌드 단계는 없습니다. 주 개발 환경은 Windows입니다.

```sh
git clone https://github.com/simpleusername96/web-bookmark-hub-template.git
cd web-bookmark-hub-template
node scripts/seed-demo.js
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/demo.sqlite3
```

[로컬 앱](http://127.0.0.1:3042/)을 엽니다. 가상 자료 20개, 폴더 4개, 직접 생성한 미리보기가 들어 있습니다. `example.test` 주소는 실제 사이트가 아닙니다. 예제 요약도 미리 작성한 합성 자료이며, 실제 AI 실행 결과를 보여주는 것은 아닙니다. 이미 있는 DB는 덮어쓰지 않습니다.

실제 자료를 저장할 빈 자료함은 서버를 종료한 뒤 다음 명령으로 시작합니다.

```sh
node registry-server.js --host 127.0.0.1 --port 3042 --db ./data/registry.sqlite3
```

SQLite 파일과 옆의 `.data` 폴더를 함께 보관하세요. `data/` 전체는 Git에서 제외됩니다. 저장한 링크, 내보낸 자료, 인증 정보와 미리보기를 Git에 추가하지 마세요.

## Codex와 함께 사용하기

Codex에서 이 프로젝트를 열고 자료 정리나 앱 변경을 요청합니다.

> 이번 주에 저장한 Normal 링크 중 메모가 없는 자료를 읽고 요약해줘. 기존 메모는 보존하고, 진행 중인 조사에 맞는 폴더 분류를 제안해줘.

> 이 템플릿을 내 디자인 레퍼런스 앱으로 바꿔줘. 원본 링크는 유지하면서 작업에 필요한 필드를 추가해줘.

Codex는 로컬 Registry 모듈과 CLI를 사용할 수 있습니다. 저장소에 에이전트 지침과 링크 정보 보강용 스킬이 포함되어 있습니다. 별도의 MCP 서버나 구독 소스의 자동 업데이트 기능은 아직 없습니다.

앱의 **AI 요약** 버튼을 쓰려면 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)를 설치하고 로그인한 뒤 `codex` 명령을 실행할 수 있어야 합니다. 현재 요약 기능은 `gpt-5.6-luna`, `max`를 요청하므로 해당 모델을 사용할 수 있는 계정이 필요합니다. 요약은 한국어로 작성되며 `enrichment/ai-summary-prompt.md`에서 바꿀 수 있습니다. 자료함 열람과 수동 정리는 AI를 실행하지 않아도 사용할 수 있습니다.

**Normal**은 AI 처리 허용, **Private**은 지원되는 AI 작업에서 제외한다는 뜻입니다. 이 설정은 앱의 처리 규칙이며, 파일시스템 접근 권한이 있는 로컬 에이전트를 물리적으로 격리하지는 않습니다.

## Chrome 확장 프로그램

1. `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 저장소 폴더를 선택합니다.
2. 확장 프로그램의 **Web UI에서 연결**을 누르고 앱의 Chrome 설정에서 승인합니다.
3. 현재 페이지를 저장하거나 보관할 이미지를 직접 선택합니다.

`Ctrl+Shift+E`(macOS는 `Command+Shift+E`)는 현재 페이지를 저장하고, 조건에 맞는 Normal 항목에 요약을 요청할 수 있습니다. 팝업의 저장 버튼은 요약을 시작하지 않고 URL을 저장합니다. 단축키가 겹치면 Chrome의 단축키 설정에서 변경하세요.

## 원하는 용도로 수정하기

| 수정할 부분 | 시작할 파일·폴더 |
| --- | --- |
| 화면과 검색 | `web/` |
| 자료·폴더·태그·저장 규칙 | `registry/` |
| 로컬 API와 인증 | `server/` |
| 브라우저 저장 | `extension/`, `profiles.js`, `popup.js` |
| 링크 정보 보강 | `enrichment/`, `agent-cli.js` |
| 더미 데이터 | `examples/`, `scripts/seed-demo.js` |

변경 전 [프로젝트 계약](docs/PROJECT.md)을 읽고, 변경 후 `node scripts/verify.js`로 검사합니다.

MIT 라이선스입니다. 개인용 도구를 만들기 위한 템플릿이며, 호스팅 서비스나 OpenAI의 공식 제품은 아닙니다.
