"""말문 — 오늘의 내용 생성기.

GitHub Actions가 매일 06:30 KST에 실행한다.
1) Google 뉴스 RSS에서 최근 36시간 기사 제목/요약을 모은다
2) Claude API로 말투(2) × 유머 강도(3) = 6가지 조합의 JSON을 만든다
3) docs/data/<날짜>/<말투>-<강도>.json 과 docs/data/index.json 을 쓴다

로컬 테스트:
  python generate.py --test-rss            뉴스 수집만 (키 불필요)
  python generate.py --only banmal-safe    한 조합만 생성
  python generate.py                       6조합 전부 생성
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import feedparser

KST = timezone(timedelta(hours=9))
MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
DATA_DIR = Path(__file__).parent / "docs" / "data"
WEEKDAYS = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]

FIELDS = ["날씨·생활", "스포츠", "음악·K팝", "영화·드라마", "IT·과학", "음식", "경제·돈", "동물·신기한 이야기"]
TONES = {"banmal": "반말", "jondae": "존댓말"}
STRENGTHS = {"safe": "안전하게", "normal": "보통", "bold": "조금 과감하게"}
SITUATIONS = ["친구 모임", "어른·선배", "처음 만난 사람", "직장·학교", "손님·고객"]

FEEDS = [
    ("주요", "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko"),
    ("과학기술", "https://news.google.com/rss/search?q=%EA%B3%BC%ED%95%99+OR+%EA%B8%B0%EC%88%A0+OR+%EC%9A%B0%EC%A3%BC+OR+AI&hl=ko&gl=KR&ceid=KR:ko"),
    ("문화", "https://news.google.com/rss/search?q=%EC%98%81%ED%99%94+OR+%EA%B3%B5%EC%97%B0+OR+%EC%A0%84%EC%8B%9C+OR+K%ED%8C%9D&hl=ko&gl=KR&ceid=KR:ko"),
    ("스포츠", "https://news.google.com/rss/search?q=%ED%94%84%EB%A1%9C%EC%95%BC%EA%B5%AC+OR+%EC%B6%95%EA%B5%AC+OR+%EC%98%AC%EB%A6%BC%ED%94%BD+OR+%EC%86%90%ED%9D%A5%EB%AF%BC&hl=ko&gl=KR&ceid=KR:ko"),
    ("생활", "https://news.google.com/rss/search?q=%EB%82%A0%EC%94%A8+OR+%EC%9C%A0%ED%96%89+OR+%ED%8A%B8%EB%A0%8C%EB%93%9C+OR+%EC%9D%8C%EC%8B%9D&hl=ko&gl=KR&ceid=KR:ko"),
    ("신기한", "https://news.google.com/rss/search?q=%EC%8B%A0%EA%B8%B0%ED%95%9C+OR+%ED%99%94%EC%A0%9C+OR+%EC%9D%B4%EC%83%89+OR+%EC%97%B0%EA%B5%AC%EA%B2%B0%EA%B3%BC&hl=ko&gl=KR&ceid=KR:ko"),
]
MAX_ITEMS_PER_FEED = 12
MAX_AGE_HOURS = 36


def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def fetch_news() -> list[dict[str, Any]]:
    cutoff = datetime.now(KST) - timedelta(hours=MAX_AGE_HOURS)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for feed_name, url in FEEDS:
        try:
            parsed = feedparser.parse(url)
        except Exception as e:  # noqa: BLE001
            print(f"[rss] {feed_name} 실패: {e}")
            continue
        count = 0
        for entry in parsed.entries:
            if count >= MAX_ITEMS_PER_FEED:
                break
            published = None
            if getattr(entry, "published_parsed", None):
                published = datetime.fromtimestamp(time.mktime(entry.published_parsed), tz=timezone.utc).astimezone(KST)
            if published and published < cutoff:
                continue
            title = _strip_html(entry.get("title", ""))
            source = ""
            if " - " in title:
                title, source = title.rsplit(" - ", 1)
            key = re.sub(r"\W+", "", title)[:40]
            if not title or key in seen:
                continue
            seen.add(key)
            items.append({
                "feed": feed_name,
                "title": title.strip(),
                "source": source.strip(),
                "published": published.strftime("%Y-%m-%d %H:%M") if published else "",
                "link": entry.get("link", ""),
                "snippet": _strip_html(entry.get("summary", ""))[:300],
            })
            count += 1
    print(f"[rss] 수집 {len(items)}건")
    return items


SYSTEM_PROMPT = """당신은 '말문'이라는 앱의 작가입니다. 말문은 사람을 만나면 무슨 말을 해야 할지 막막한 사람,
자신감이 낮은 사람을 위한 앱이에요. 하루에 한마디만 실제로 꺼내 보게 하는 것이 목표입니다.

톤 원칙: 담백하고 품위 있는 유머. 유치한 말장난, 억지 개그, 과한 자기비하, 상대를 소재로 삼는 농담은 쓰지 않습니다.
사용자가 사람들 앞에서 그대로 말해도 부끄럽지 않을 문장만 씁니다.

가장 중요한 규칙: 상대가 그 소식을 모른다고 전제합니다.
- 한마디 안에 사실이 들어 있어야 합니다. ("어제 서울이 30도였대" O / "노벨상 누가 받았는지 알아?" X)
- 모든 한마디에는 상대가 "그게 뭔데?"라고 했을 때 10초 안에 말할 설명 한 줄(explain)을 붙입니다.
- 뉴스는 "이런 게 있었대"로 가볍게 전달합니다. 날씨·계절·음식 같은 생활 소재도 좋지만, 한 소재가 여러 곳에 반복되면 안 됩니다.

분야(field) 규칙
- 모든 뉴스(news.tag)와 한마디(openers[].field)에는 다음 8개 분야 중 하나를 정확히 그 표기로 씁니다:
  날씨·생활, 스포츠, 음악·K팝, 영화·드라마, IT·과학, 음식, 경제·돈, 동물·신기한 이야기
- 사용자는 앱에서 관심 분야를 고르고, 앱이 분야별로 한마디를 골라 보여 줍니다. 그래서 분야가 고르게 섞여야 합니다.

지역 규칙
- 사용자는 전국에 있습니다. 서울 기준 날씨나 소식을 모두의 일처럼 쓰지 않습니다.
  "어제 서울이 30도였대" 대신 "어제 서울은 30도까지 갔대. 너희 동네도 더웠어?"처럼 지역 차이를 열어 두는 표현을 씁니다.
- 날씨·생활 분야의 한마디는 자리마다 최대 1개로 하고, 앱이 사용자 지역의 실제 날씨 한마디를 따로 붙이니 전국 공통 소재(계절, 옷차림, 음식)를 우선합니다.

소재 다양성 규칙 (반드시 지킵니다)
- news의 talk 7개는 서로 다른 분야(tag)여야 합니다. 같은 tag가 2개 이상이면 안 됩니다.
- openers는 자리마다 4개씩 쓰고, 한 자리 안의 4개는 서로 다른 분야여야 합니다. 5개 자리를 합쳐 8개 분야가 모두 최소 1번은 나와야 합니다.
- 날씨·생활을 첫 번째로 쓰는 자리는 최대 2곳.
- today(오늘의 한마디)와 lede(소개 문장)는 같은 소재를 반복하지 않습니다. lede는 오늘 소재 전체를 한 문장으로 훑습니다.

절대 규칙
- 뉴스는 제공된 기사 목록 안에서만 고르고, 제목·요약에 없는 사실을 지어내지 않습니다.
- 기사 문장을 그대로 옮기지 말고 완전히 내 말로 짧게 요약합니다.
- 정치, 선거, 사건사고, 재난, 인명 피해, 전쟁, 성별·지역·종교·외모·특정 집단은 유머 소재로 쓰지 않습니다.
  이런 소식은 kind="know"(알아만 두기)로만 넣습니다.
- 유머는 반드시 새로 짓습니다.
- 대화에서 같은 화자가 2번 이상 연속으로 말하지 않습니다. a가 사용자, b가 상대입니다.
- 날짜 표현(내일/모레)은 오늘 기준으로 정확히. 애매하면 날짜를 씁니다.
- 썰렁했을 때 수습하는 장면을 대화 예시 중 하나에 반드시 넣습니다.
- 가벼운 소식이 부족하면 억지로 채우지 말고 개수를 줄이고 lede에 "오늘은 가벼운 소재가 적어요"라고 씁니다.

출력은 아래 JSON 하나만, 설명이나 코드펜스 없이.
{
  "lede": "오늘 소개 한 문장",
  "today": {"situation": "상황 이름", "text": "오늘의 한마디", "why": "왜 이 말이 좋은지 한 줄", "explain": "상대가 모르면 이렇게 설명해요 한 줄"},
  "openers": {
    "친구 모임": [{"field": "8개 분야 중 하나", "topic": "소재", "safety": "가장 안전|가벼움|상대가 관심 있을 때", "text": "꺼낼 말", "explain": "모르면 이렇게"}],
    "어른·선배": [...], "처음 만난 사람": [...], "직장·학교": [...], "손님·고객": [...]
  },
  "fallback_question": {"text": "말이 끊길 때 던질 질문 하나", "why": "왜 이 질문이 좋은지"},
  "scenes": [
    {"title": "상황 이름", "topics": "녹인 소재", "lines": [
      {"who": "a|b", "text": "대사(2문장 이내)", "humor": null | {"type": "반전|의인화|과장|자조|능청|말장난", "why": "왜 웃긴지 1~2문장"}}
    ]}
  ],
  "drills": [{"q": "상황과 과제", "hints": ["힌트 유형 1", "힌트 유형 2"], "answer": "예시 한마디", "note": "유형과 설명 한 줄"}],
  "news": [{"kind": "talk|know", "tag": "8개 분야 중 하나 (know는 '알아만 두기')", "title": "요약형 제목", "summary": "한두 문장", "context": "배경과 왜 중요한지 2~3문장. 세상 돌아가는 걸 모르는 사람에게 설명하듯, 중립적으로", "source": "언론사", "url": "링크"}],
  "term": {"word": "오늘 뉴스에 나온 용어 하나", "meaning": "쉬운 말로 한두 문장", "example": "대화에서 쓰는 예 한 문장"},
  "weather_templates": [
    {"cond": "rain|swing|hot|cold|mild", "text": "빈칸이 든 한마디", "explain": "빈칸이 든 설명 한 줄"}
  ],
  "types": [{"name": "유형", "desc": "한 줄"}]
}

날씨 문장 틀 규칙 (weather_templates)
- 앱이 사용자 지역의 실제 날씨 숫자를 채워 넣습니다. 빈칸은 정확히 이 표기만 씁니다: {지역} {최고} {최저} {비확률} {내일최고} {날씨}
- cond 다섯 가지(rain=비 올 확률 높음, swing=오늘과 내일 기온 차 큼, hot=더움, cold=아침 쌀쌀, mild=평범)마다 2개씩, 총 10개.
- 오늘 날짜·계절에 맞는 표현을 쓰되, 서울 등 특정 도시 이름은 넣지 않습니다. 말투 설정(반말/존댓말)을 따릅니다.
- 예: {"cond":"rain","text":"오늘 {지역} 비 올 확률 {비확률}%래. 우산 챙겼어?","explain":"오늘 {지역} 낮 최고 {최고}도, 비 올 확률 {비확률}%야."}

"세상" 탭 규칙 (news와 term)
- 사용자는 세상 돌아가는 걸 잘 모르는 사람입니다. context는 전제 지식 없이 읽히게, 고유명사엔 짧은 설명을 붙입니다.
- know(알아만 두기)는 5개: 정치·경제·사회에서 오늘 가장 중요한 소식. 유머 없이, 한쪽 편을 들지 않고, 사실과 쟁점만 씁니다.
  정치 소식은 "누가 무엇을 했고, 찬성 쪽과 반대 쪽은 각각 뭐라 하는지"로 씁니다.
- term은 오늘 뉴스에 실제로 나온 말에서 고릅니다. 너무 쉬운 말(예: 날씨)은 피합니다.

분량: openers는 상황 5개 각각 4개(총 20). scenes 2개(각 8~10줄, 유머 2~3개, 둘 중 하나는 썰렁 수습 장면 포함).
drills 3개. news는 talk 7 + know 5 (모두 context 포함). term 1개. weather_templates 10개. types는 오늘 쓴 유형만."""


def tone_instruction(tone: str, strength: str) -> str:
    t = {
        "banmal": "말투: 사용자 대사(a)와 한마디는 친근한 반말로 씁니다. 단, '어른·선배'와 '손님·고객' 상황의 오프너와 대화는 존댓말로 씁니다.",
        "jondae": "말투: 모든 사용자 대사(a)와 한마디를 부드러운 존댓말로 씁니다.",
    }[tone]
    s = {
        "safe": "유머 강도: 안전하게. 날씨·계절·사물 의인화·나를 살짝 낮추는 자조 위주. 상대나 제3자를 소재로 삼지 않고, 반전도 온화하게.",
        "normal": "유머 강도: 보통. 반전·과장·능청을 고루 쓰되 품위를 지킵니다.",
        "bold": "유머 강도: 조금 과감하게. 반전과 능청을 적극적으로 쓰고 말장난도 허용하지만, 여전히 상대·집단·민감 소재는 금지입니다.",
    }[strength]
    return t + "\n" + s


def build_user_prompt(today: datetime, items: list[dict[str, Any]], tone: str, strength: str, prev: dict | None) -> str:
    lines = [f"오늘은 {today.strftime('%Y년 %m월 %d일')} {WEEKDAYS[today.weekday()]}입니다.", tone_instruction(tone, strength)]
    if prev:
        lines.append("어제 상황: " + ", ".join(s.get("title", "") for s in prev.get("scenes", [])) + ". 오늘은 다른 상황 조합을 쓰세요.")
    lines.append("")
    lines.append("최근 36시간 기사 목록. [번호] 제목 | 언론사 | 시각 | 요약 | 링크")
    for i, it in enumerate(items, 1):
        lines.append(f"[{i}] {it['title']} | {it['source']} | {it['published']} | {it['snippet']} | {it['link']}")
    lines.append("")
    lines.append("규칙에 따라 JSON만 출력하세요.")
    return "\n".join(lines)


def _extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text)
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1:
        raise ValueError("JSON을 찾지 못했습니다")
    return json.loads(text[s : e + 1])


def _validate(p: dict) -> list[str]:
    problems = []
    if not p.get("today", {}).get("text"):
        problems.append("today 없음")
    if not p.get("today", {}).get("explain"):
        problems.append("today.explain 없음")
    for sit in SITUATIONS:
        if len(p.get("openers", {}).get(sit, [])) < 2:
            problems.append(f"openers[{sit}] 부족")
    # 분야 중복 제거: 같은 tag는 처음 것만 남긴다
    seen_tags: set[str] = set()
    deduped = []
    for n in p.get("news", []):
        key = (n.get("kind"), (n.get("tag") or "").strip())
        if n.get("kind") == "talk" and key[1] in seen_tags:
            continue
        if n.get("kind") == "talk":
            seen_tags.add(key[1])
        deduped.append(n)
    p["news"] = deduped
    talk = [n for n in p.get("news", []) if n.get("kind") == "talk"]
    if len(talk) < 4:
        problems.append(f"talk 뉴스 {len(talk)}개로 부족(분야 중복 제거 후)")
    know = [n for n in p.get("news", []) if n.get("kind") == "know"]
    if len(know) < 3:
        problems.append(f"알아만 두기 {len(know)}개로 부족(최소 3)")
    if sum(1 for n in p.get("news", []) if not n.get("context")) > 2:
        problems.append("context 없는 뉴스가 3개 이상")
    # 분야 표기 정규화 + 자리 안 분야 중복 제거
    def norm_field(s: str) -> str:
        s = (s or "").strip()
        if s in FIELDS:
            return s
        for f in FIELDS:
            if f.split("·")[0] in s or s in f:
                return f
        return "날씨·생활" if ("날씨" in s or "계절" in s) else "동물·신기한 이야기"
    for sit, lst in p.get("openers", {}).items():
        seen_f: set[str] = set()
        kept = []
        for o in lst:
            o["field"] = norm_field(o.get("field") or o.get("topic", ""))
            if o["field"] in seen_f:
                continue
            seen_f.add(o["field"])
            kept.append(o)
        p["openers"][sit] = kept
    for n in p.get("news", []):
        if n.get("kind") == "talk":
            n["tag"] = norm_field(n.get("tag", ""))
    all_fields = {o["field"] for lst in p.get("openers", {}).values() for o in lst}
    if len(all_fields) < 6:
        problems.append(f"분야가 {len(all_fields)}개뿐 (8개 중 최소 6개)")
    firsts = [v[0].get("field", "") for v in p.get("openers", {}).values() if v]
    if sum(1 for f in firsts if f == "날씨·생활") > 2:
        problems.append("자리 첫 한마디 중 날씨·생활이 3곳 이상 (최대 2)")
    if len(p.get("scenes", [])) < 1:
        problems.append("scenes 없음")
    for s in p.get("scenes", []):
        prev = None
        for ln in s.get("lines", []):
            if ln.get("who") == prev:
                problems.append(f"'{s.get('title')}' 같은 화자 연속")
                break
            prev = ln.get("who")
    if len(p.get("drills", [])) < 1:
        problems.append("drills 없음")
    return problems


def call_claude(system: str, user: str) -> str:
    """텍스트로 JSON을 받는다. (도구 호출은 한글을 \\u 이스케이프로 써서 토큰이 6배로 늘어 실패했음)"""
    import anthropic

    client = anthropic.Anthropic()
    guard = ("\n\n출력 규칙: 설명 없이 JSON 객체 하나만 출력하세요. 코드펜스(```)도 쓰지 마세요. "
             "JSON 문자열 안의 한글은 \\u 이스케이프 없이 한글 그대로 씁니다. 첫 글자는 { 입니다.")
    # 이 모델은 기본으로 '생각'이 켜져 있고 그 토큰이 max_tokens에 포함된다 → 끈다
    with client.messages.stream(
        model=MODEL, max_tokens=int(os.getenv("MAX_TOKENS", "32000")), system=system,
        messages=[{"role": "user", "content": user + guard}],
        thinking={"type": "disabled"},
        output_config={"effort": "medium"},
    ) as stream:
        resp = stream.get_final_message()
    text = "".join(getattr(b, "text", "") for b in resp.content)
    kinds = [(getattr(b, "type", "?"), len(getattr(b, "text", "") or getattr(b, "thinking", "") or "")) for b in resp.content]
    usage = getattr(resp, "usage", None)
    if resp.stop_reason == "max_tokens":
        raise RuntimeError(f"출력이 max_tokens에서 잘렸습니다 (len={len(text)}) blocks={kinds} usage={usage} 앞={text[:200]!r} 뒤={text[-200:]!r}")
    print(f"[claude] blocks={kinds} usage={usage}")
    return text


def generate_variant(today: datetime, items: list[dict[str, Any]], tone: str, strength: str, prev: dict | None) -> dict:
    user_prompt = build_user_prompt(today, items, tone, strength, prev)
    payload, last_err = None, ""
    for attempt in range(2):
        prompt = user_prompt if attempt == 0 else user_prompt + f"\n\n이전 출력 문제: {last_err}. 고쳐서 다시 JSON만 출력하세요."
        raw = call_claude(SYSTEM_PROMPT, prompt)
        try:
            cand = _extract_json(raw)
        except Exception as e:  # noqa: BLE001
            last_err = f"JSON 파싱 실패: {e} | 응답 앞부분: {raw[:300]!r} | 끝부분: {raw[-200:]!r}"
            continue
        problems = _validate(cand)
        payload = cand
        if problems and attempt == 0:
            last_err = "; ".join(problems)
            continue
        break
    if payload is None:
        raise RuntimeError(last_err or "생성 실패")
    payload.update({
        "date": today.strftime("%Y-%m-%d"),
        "weekday": WEEKDAYS[today.weekday()],
        "tone": tone,
        "strength": strength,
        "generated_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
        "model": MODEL,
    })
    return payload


def write_index():
    dates = sorted([p.name for p in DATA_DIR.iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name)], reverse=True)
    index = {"latest": dates[0] if dates else None, "dates": dates[:60], "tones": list(TONES), "strengths": list(STRENGTHS)}
    (DATA_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[index] latest={index['latest']} ({len(dates)}일)")


def main(argv: list[str]) -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if "--test-rss" in argv:
        for it in fetch_news():
            print(f"[{it['feed']}] {it['published']} | {it['title']} | {it['source']}")
        return 0
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY가 없습니다", file=sys.stderr)
        return 2

    today = datetime.now(KST)
    date = today.strftime("%Y-%m-%d")
    out_dir = DATA_DIR / date
    out_dir.mkdir(exist_ok=True)

    items = fetch_news()
    if len(items) < 8:
        print(f"기사가 {len(items)}건뿐입니다. 중단.", file=sys.stderr)
        return 3

    prev = None
    prev_dir = DATA_DIR / (today - timedelta(days=1)).strftime("%Y-%m-%d")
    prev_file = prev_dir / "banmal-safe.json"
    if prev_file.exists():
        prev = json.loads(prev_file.read_text(encoding="utf-8"))

    only = None
    if "--only" in argv:
        only = argv[argv.index("--only") + 1]

    combos = [(t, s) for t in TONES for s in STRENGTHS]
    log: list[str] = [f"run {datetime.now(KST).strftime('%Y-%m-%d %H:%M')} model={MODEL} items={len(items)}"]
    attempted = failures = 0
    for tone, strength in combos:
        name = f"{tone}-{strength}"
        if only and name != only:
            continue
        target = out_dir / f"{name}.json"
        if target.exists() and "--force" not in argv:
            print(f"[skip] {name} 이미 있음")
            log.append(f"skip {name}")
            continue
        attempted += 1
        try:
            payload = generate_variant(today, items, tone, strength, prev)
            target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"[ok] {name}")
            log.append(f"ok {name}")
        except Exception as e:  # noqa: BLE001
            failures += 1
            import traceback

            msg = f"fail {name}: {e!r}\n{traceback.format_exc()[-1500:]}"
            print("[" + msg, file=sys.stderr)
            log.append(msg)
    write_index()
    runs_dir = DATA_DIR / "_runs"
    runs_dir.mkdir(exist_ok=True)
    (runs_dir / f"{date}.txt").write_text("\n".join(log) + "\n", encoding="utf-8")
    return 1 if attempted and failures == attempted else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
