# HU Editor 개발

소스에서 빌드하고 시험하고 배포하는 방법입니다. 프로그램 사용법은 [README.md](README.md)에 있습니다.

## 구조

```
crates/hu-core/   디스크 기반 문서: 블록 캐시, 백그라운드 줄 인덱스, 뷰포트, 검색, Markdown 변환, 파일 비교 (UI 의존성 없음)
crates/hu-diff/   줄 해시 수열의 비교(patience + Myers)와 줄 안 비교. 문서와 무관한 알고리즘만
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

## 버전과 배포

버전은 루트 `Cargo.toml`의 `[workspace.package] version` 한 곳에만 적습니다. 앱(정보 창, 설치 파일)도 이 값을 씁니다. 바뀐 점은 [CHANGELOG.md](CHANGELOG.md)에 적습니다.

Windows 설치 파일(NSIS `.exe`, `.msi`)과 휴대용 zip은 GitHub Actions의 Release 워크플로가 만듭니다. Actions 탭에서 직접 실행하면 이것들만 만들어 결과물(artifact)로 올립니다. 휴대용 zip에는 `HU Editor.exe`와 `THIRD_PARTY_NOTICES.txt`가 들어 있습니다.

배포할 때는 다음 순서를 따릅니다.

1. `Cargo.toml`의 버전을 올리고 `cargo check`로 `Cargo.lock`을 맞춥니다.
2. `CHANGELOG.md`에서 그 버전 제목의 "미출시"를 날짜로 바꿉니다. 예: `## [0.2.0] - 2026-12-01`
3. 커밋하고 `git tag v0.2.0`, `git push origin main v0.2.0`을 실행합니다.

태그를 올리면 워크플로가 태그, `Cargo.toml`, 변경 기록이 서로 맞는지 확인합니다. 그다음 Windows에서 코어 테스트와 빌드를 하고, 변경 기록의 그 버전 부분을 설명으로 붙여 초안 릴리스를 만듭니다. 초안은 GitHub의 Releases에서 확인하고 게시합니다. 코드 서명은 하지 않습니다.

## 라이선스 고지

설치 파일과 휴대용 zip에는 앱에 들어간 라이브러리의 라이선스를 모은 `THIRD_PARTY_NOTICES.txt`가 함께 들어가고, 도움말 메뉴의 오픈 소스 라이선스로 열 수 있습니다. 이 파일은 `npm run build`(설치 파일을 만들 때도 실행됨)가 `app/scripts/notices.mjs`로 새로 만듭니다. 대상은 Windows용 프로그램에 들어가는 Rust 크레이트와 화면에 묶이는 npm 패키지이고, 빌드할 때만 쓰는 것은 빠집니다. 개발 빌드에도 이 파일이 있어야 하므로 저장소에 올려 둡니다. 의존성을 바꾼 뒤 `npm run build`를 실행하면 바뀐 내용이 같이 커밋됩니다.

## 화면 언어

언어를 추가하려면 `app/src/lib/i18n/`에 파일을 하나 더 만듭니다. 인코딩·솔버·카드 이름과 OS가 주는 오류 메시지는 번역하지 않습니다.
