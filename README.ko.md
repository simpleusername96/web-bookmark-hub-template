# Web Bookmark Hub

한국어 · [English](README.md)

**Codex와 함께 나만의 웹 자료 정리 도구를 만드는 템플릿입니다.**

블로그, arXiv, X, LinkedIn 등에서 읽은 자료를 저장하고 요약·검색·폴더·태그로 정리합니다. 이 앱을 출발점으로 삼아, Codex에 본인의 목적에 맞는 기능과 화면을 만들어 달라고 요청하세요.

![자료함](docs/images/library-ko.png)

## Codex로 시작하기

**Use this template**으로 저장소를 만들고, 내 컴퓨터에 받아 Codex에서 엽니다. 원하는 용도를 넣어 요청하세요.

> 이 템플릿을 [논문 리서치 / 디자인 레퍼런스 / 업무 자료 정리]용으로 바꿔줘.
> 프로젝트 지침과 docs/SETUP.md를 읽고 실행 환경을 준비해줘. 앱을 실행하고 Chrome 확장 프로그램 연결을 안내해줘.
> 그다음 내 작업에 맞는 분류와 화면을 함께 정하자.

## 읽다가 저장하기

페이지에서 **Ctrl+Shift+E**를 누르면 저장 후 Codex가 요약합니다. macOS는 **Command+Shift+E**입니다.

| 읽던 페이지 | 자료함에서 다시 열기 |
| --- | --- |
| ![읽던 글](docs/images/reading-ko.png) | ![원문과 요약](docs/images/summary-ko.png) |

자동 요약을 쓰려면 Codex CLI 로그인과 **Rules → Defaults → Normal (local)** 설정이 필요합니다. Private 자료는 AI 처리에서 제외됩니다.

## 확장 프로그램에서 누를 것

`chrome://extensions` → **개발자 모드** → **압축해제된 확장 프로그램 로드**에서 저장소 폴더를 선택합니다.

| 1. 연결 | 2. 링크 저장 | 3. 저장한 글 열기 |
| --- | --- | --- |
| ![연결 버튼](docs/images/extension-connect.png) | ![현재 페이지 저장 버튼](docs/images/extension-save.png) | ![저장 완료와 바로가기](docs/images/extension-saved.png) |
| **Web UI에서 연결**을 누른 뒤, 앱에서 **연결 승인** | **현재 페이지 저장**을 누르면 링크 저장. 요약까지 하려면 **Ctrl+Shift+E** | **바로가기**를 누르면 저장한 항목으로 이동 |

이미지를 고르려면 **페이지에서 이미지 선택**을 누릅니다. 폴더와 태그는 **저장 옵션**에서 지정할 수 있습니다.

---

로컬 저장 · 한국어/영어 UI · [실행 환경과 설정](docs/SETUP.md) · [MIT](LICENSE)
