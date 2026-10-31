# HU Editor

Abaqus / Nastran 해석 입력 파일용 대용량 텍스트 에디터. Rust 코어 + Tauri 2 (Svelte) UI.

## 구조

```
crates/hu-core/   디스크 기반 문서: 블록 캐시, 백그라운드 줄 인덱스, 뷰포트, 검색 (UI 의존성 없음)
crates/hu-gen/    합성 테스트 덱 생성기 (Abaqus .inp / Nastran .bdf)
app/              Tauri 2 앱 (src-tauri: IPC 커맨드, src: Svelte 프론트엔드)
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

## 단축키

| 키 | 동작 |
|---|---|
| Ctrl+O | 파일 열기 (드래그 앤 드롭도 가능, 폴더를 끌어다 놓으면 탐색기에서 펼침) |
| Ctrl+B | 탐색기 열기 / 닫기 (화살표로 이동, Enter로 열기, ←/→로 접기 / 펼치기, 상단 주소창에 경로 붙여넣기) |
| Ctrl+S | 저장 (임시 파일에 쓴 뒤 원본과 교체) |
| Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) | 실행 취소 / 다시 실행 |
| Ctrl+C / Ctrl+X / Ctrl+V | 복사 / 잘라내기 / 붙여넣기 (선택 없으면 현재 줄) |
| Ctrl+A, Shift+방향키, 더블·트리플 클릭 | 선택 |
| Tab | 다음 8칸 경계까지 공백 (Nastran small field) |
| Ctrl+F, Enter / Shift+Enter, F3 / Shift+F3 | 찾기, 다음 / 이전 |
| Ctrl+G | 줄 번호로 이동 |
| Home / End, PageUp / PageDown, Ctrl+Home / End | 줄 처음·끝, 페이지 이동, 파일 처음·끝 |
