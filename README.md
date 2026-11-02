# HU Editor

Abaqus / Nastran 해석 입력 파일용 대용량 텍스트 에디터. Rust 코어 + Tauri 2 (Svelte) UI.

## 구조

```
crates/hu-core/   디스크 기반 문서: 블록 캐시, 백그라운드 줄 인덱스, 뷰포트, 검색 (UI 의존성 없음)
crates/hu-gen/    합성 테스트 덱 생성기 (Abaqus .inp / Nastran .bdf)
app/              Tauri 2 앱 (src-tauri: IPC 커맨드, src: Svelte 프론트엔드, e2e: 화면 시나리오)
```

## 실행

```sh
cd app
npm install
npm run tauri dev
```

## 테스트 / 벤치마크

```sh
cargo test --workspace
cargo run --release -p hu-gen -- nastran 30G /path/to/plates.bdf      # abaqus | nastran, 크기 500M / 2G / 30G ...
cargo run --release -p hu-core --example bench -- /path/to/plates.bdf [검색어]
```

### 화면 시나리오

실제 화면 코드를 브라우저에서 실제 코어와 연결해 돌리고, 사용자가 보는 결과를 확인합니다. 설치된 Chrome(Windows에서는 Edge)을 씁니다.

```sh
cd app
npm run e2e                # 전체
npm run e2e -- box tabs    # 이름을 지정한 시나리오만 (e2e/scenarios/)
npm run e2e -- --verbose   # 통과한 항목도 표시
npm run e2e -- --keep      # 테스트 파일과 스크린샷을 지우지 않고 위치를 알려 줌
npm run e2e -- --big       # 1GB 덱 시나리오도 함께 (느리고 디스크가 필요함)
```

Tauri 명령 층은 `e2e/bridge`가 대신합니다. 앱에 명령을 추가하면 브리지에도 추가해야 하고, 빠져 있으면 시나리오를 시작하기 전에 알려 줍니다. 실제 창과 네이티브 대화 상자는 이 시나리오로 확인되지 않습니다.

## 단축키

| 키 | 동작 |
|---|---|
| Alt+F, E, S, V, H | 파일, 편집, 찾기, 보기, 도움말 메뉴 열기 (방향키로 이동, Enter 또는 밑줄 글자로 실행, Esc로 닫기) |
| Alt, F10 | 키보드로 메뉴 막대로 이동 |
| Ctrl+O | 파일 열기 (드래그 앤 드롭도 가능, 폴더를 끌어다 놓으면 탐색기에서 펼침) |
| Ctrl+B | 탐색기 열기 / 닫기 (화살표로 이동, Enter로 열기, ←/→로 접기 / 펼치기, 상단 주소창에 경로 붙여넣기) |
| Ctrl+N | 새 파일 (인코딩·줄바꿈은 설정에 따름, 기본은 UTF-8·OS 기본 줄바꿈) |
| Ctrl+W, 가운데 클릭 | 탭 닫기 (저장 안 한 변경이 있으면 물어봄) |
| Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / PageUp | 다음 / 이전 탭 (열려 있던 파일은 다음 실행 때 다시 열림) |
| Ctrl+S | 저장 (임시 파일에 쓴 뒤 원본과 교체; 새 파일은 이름부터 물어봄) |
| Ctrl+Shift+S | 다른 이름으로 저장 (원본은 그대로, 이후 저장은 새 파일로) |
| Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) | 실행 취소 / 다시 실행 |
| Ctrl+C / Ctrl+X / Ctrl+V | 복사 / 잘라내기 / 붙여넣기 (선택 없으면 현재 줄) |
| Ctrl+A, Shift+방향키, 더블·트리플 클릭 | 선택 |
| Tab | 다음 8칸 경계까지 공백 (Nastran small field) |
| Alt+드래그, Alt+Shift+방향키 | 박스(컬럼) 선택. 입력·Backspace·Delete·Tab·복사·붙여넣기가 모든 줄에 적용 (짧은 줄은 공백으로 채움, 여러 줄 붙여넣기는 위에서부터 한 줄씩) |
| Alt+C | 컬럼 모드 켜기 / 끄기 (켜면 Shift+방향키와 드래그가 박스 선택, 상태바에 COL) |
| Ctrl+F, Enter / Shift+Enter, F3 / Shift+F3 | 찾기, 다음 / 이전. 한 줄 안에서 선택한 글자가 있으면 찾을 말로 들어가고, 화면의 일치 항목이 모두 강조됨. 찾기 창이 닫혀 있어도 F3은 마지막 찾을 말로 이어서 찾음 |
| Ctrl+F3 / Ctrl+Shift+F3 | 선택한 글자나 캐럿 위치의 단어를 바로 찾기, 다음 / 이전 |
| Ctrl+H, Enter, Ctrl+Alt+Enter | 바꾸기, 바꾸고 다음 찾기, 모두 바꾸기 (한 번에 실행 취소, 최대 200만 건). 선택한 글자가 있으면 바로 바꿀 말을 입력 |
| 상태바의 인코딩 표시 클릭 | Read as: 다른 인코딩으로 다시 읽기 (파일은 그대로, 선택은 파일별로 기억) / Save as: 변환해서 저장 (없는 글자나 깨진 바이트가 있으면 중단) |
| Ctrl+G | 줄 번호로 이동 |
| Home / End, PageUp / PageDown, Ctrl+Home / End | 줄 처음·끝, 페이지 이동, 파일 처음·끝 |
| Ctrl+, | 설정 |

## 설정

Ctrl+, 또는 파일 메뉴의 설정으로 엽니다. 바꾸면 바로 적용되고, 다른 PC로 복사할 수 있는 파일에 저장됩니다 (Windows: `%APPDATA%\dev.hueditor.editor\settings.json`).

- **일반**: 언어 (English / 한국어, 처음에는 OS 언어를 따름), 시작할 때 지난 파일 다시 열기, 탐색기에 숨김 파일 표시
- **편집기**: 글꼴과 크기, 줄 번호, 현재 줄 강조, Tab 키 입력 (스페이스 칸 수 또는 탭 문자), 문법 강조, Nastran 필드 음영
- **파일**: 새 파일의 인코딩·줄바꿈, UTF-8이 아닌 파일의 인코딩 (이후 여는 파일에 적용), 내용으로 판단할 수 없는 `.blk` 파일의 솔버
- **단축키**: 목록 보기 (변경은 아직 안 됨)

언어를 추가하려면 `app/src/lib/i18n/`에 파일을 하나 더 만듭니다. 인코딩·솔버·카드 이름과 OS가 주는 오류 메시지는 번역하지 않습니다.
