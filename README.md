# 말문

사람을 만나면 무슨 말을 해야 할지 막막한 분을 위한, **하루 한마디** 대화 코치예요.
매일 아침 그날의 소식으로 꺼낼 수 있는 한마디와 대화 예시를 준비하고, 실제로 한 번 말해 본 걸 기록으로 쌓아요.

- 회원가입 없음. 기록은 사용자의 기기에만 저장.
- 서버 없음. 생성은 GitHub Actions, 배포는 GitHub Pages.
- 웹앱(PWA) 하나로 안드로이드·아이폰·PC 모두 대응. 플레이스토어는 TWA로 패키징.

## 구조

```
malmun/
├─ generate.py                 뉴스 RSS 수집 + Claude API 생성 → docs/data/<날짜>/<말투>-<강도>.json
├─ requirements.txt
├─ .github/workflows/daily.yml 매일 06:30 KST 생성 후 커밋
└─ docs/                       GitHub Pages 루트
   ├─ index.html, app.js, app.css   앱
   ├─ manifest.json, sw.js, icons/  PWA
   └─ data/
      ├─ index.json                  최신 날짜 목록
      └─ 2026-10-13/banmal-safe.json 예시 데이터
```

말투 2종(반말 `banmal` / 존댓말 `jondae`) × 유머 강도 3단계(`safe` / `normal` / `bold`) = 하루 6개 파일.
앱은 사용자의 설정에 맞는 파일을 받고, 없으면 `banmal-safe`로 대체해요.

## 처음 설정

1. **Secrets**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - 이름 `ANTHROPIC_API_KEY`, 값은 console.anthropic.com에서 발급한 키
2. **Pages**: Settings → Pages → Source "Deploy from a branch", Branch `main`, 폴더 `/docs` → Save
   - 몇 분 뒤 `https://<계정>.github.io/malmun/` 에서 열려요
3. **첫 생성**: Actions 탭 → "오늘의 말문 생성" → Run workflow
   - 이후엔 매일 06:30 KST에 자동으로 돌아요

## 로컬에서 돌려 보기

```
pip install -r requirements.txt
python generate.py --test-rss            # 뉴스 수집만 확인 (키 불필요)
ANTHROPIC_API_KEY=... python generate.py --only banmal-safe
cd docs && python -m http.server 8080    # http://localhost:8080
```

## 콘텐츠 원칙

- 상대가 소식을 모른다고 전제해요. 한마디 안에 사실이 들어 있고, "모르면 이렇게 설명해요" 한 줄이 항상 붙어요.
- 정치·사건사고·재난·종교·특정 집단은 유머 소재로 쓰지 않아요. "알아만 두기"로만 보여요.
- 기사 문장을 옮기지 않고 요약만 해요. 출처 링크를 항상 달아요.
- 썰렁했을 때 수습하는 장면을 대화 예시에 반드시 넣어요.
- 연속 기록을 잃는 구조, 점수, 비교는 쓰지 않아요.

## 플레이스토어 (다음 단계)

1. Pages 주소가 HTTPS로 열리는지 확인
2. [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)으로 TWA 생성: `bubblewrap init --manifest https://<계정>.github.io/malmun/manifest.json`
3. `docs/.well-known/assetlinks.json` 에 서명 키 지문 등록
4. Play Console 개발자 등록(1회 25달러) 후 AAB 업로드, 개인정보 처리방침 주소는 `https://<계정>.github.io/malmun/#privacy`
