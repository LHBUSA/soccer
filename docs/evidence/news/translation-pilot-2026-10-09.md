# Spanish newsroom translation pilot — 2026-10-09

Owner approval: "OWNER APPROVAL — SPANISH SOCCER NEWSROOM" (2026-10-09); Issue #15 stage 1.
Contract: `workers/shared/article-i18n.js` (soccer-article-i18n/1). Desk: `workers/soccer-news/src/translate.js`.
Storage: `public.soccer_article_translations` (migration 20261009001600, applied 2026-10-09 after a rollback-only proof,
a negative control, and an unchanged catalog fingerprint).

## Method

- **Which articles:** 10 published English articles, chosen across 5 desks (Bundesliga, Premier League, MLS,
  international/Nations League) and 6 story types (match report, preview, matchday brief, player form, team form,
  table/group watch). The list is in `workers/soccer-news/wrangler.toml` (`SOCCER_TRANSLATE_ES_PILOT`).
- **How:** pilot mode on the Worker's cron (3 per tick, each article tried once per English revision and translator
  version), using the Worker's own secrets.
- **Pipeline:**
  1. translator (gpt-5.6-sol, low effort);
  2. deterministic gates: coverage, numbers, names (incl. national-team exonyms), dates, quotes, attribution, added
     claims, leftover English, length;
  3. **independent check** (a separate model call that sees only the English and the Spanish);
  4. publish or hold.
- **Never published:** a hold. The English row is never written.

## Results (production, `soccer_article_translations`)

| Desk | Type | Article | Versions | Fluency (check) |
|---|---|---|---|---|
| Bundesliga | preview | borussia-dortmund-werder-bremen-preview-2026-10-09-2ffe56 | v1 published | native |
| Bundesliga | matchday brief | bundesliga-matchday-2026-10-10-d96a9c | v1 held (English ordinals) → v2 published | good |
| Bundesliga | match report | bayern-munchen-1-fc-union-berlin-2026-09-18-3ce080 | v1 held (English ordinal "16th") → v2 published | good |
| Premier League | player form | erling-haaland-scoring-run-2026-09-20-be6e54 | v1 published | native |
| Premier League | match report | manchester-city-sunderland-2026-09-20-da838b | v1 published | native |
| International | player form | harry-kane-scoring-run-2026-10-06-96b1f1 | v1 held (English number words) → v2 published | good |
| International | group watch | uefa-nations-league-groups-2026-09-29-f65a7a | v1 published | good |
| MLS | match report | austin-fc-san-diego-fc-2026-09-27-ac300b | v1 published | native |
| MLS | team form | seattle-sounders-fc-8-league-matches-unbeaten-2026-10-02-adae3a | v1 held ("canonical" → "oficiales") → v2 held (gate false positive "New England") → v3 published | native |
| MLS | table watch | mls-table-2026-09-27-c0405b | v1 held ("The Whitecaps" left in English) → v2 published | good |

**10/10 published.** All 7 holds were caught before publication: 6 by the independent check, 1 by a deterministic gate.

## What the holds taught, and the fixes

| Translator | Finding | Fix |
|---|---|---|
| 1.1.0 | English number words left ("four", "six"), English ordinals ("16th") | Instructions: translate number words, never turn them into digits; ordinals in the target form. Gates for both. |
| 1.1.0 | National teams left in English ("England") | A fixed national-team exonym list (England → Inglaterra), required by the names gate. Clubs, players and competitions keep their canonical names. |
| 1.1.1 | "canonical results" → "resultados oficiales" (an added claim of officialness) | Glossary: canonical = canónico, never "oficial" (also pt/fr). |
| 1.1.2 | Gate false positive: "New England" (the club) read as the nation | `nationMentioned()`: a nation preceded by another capitalized name word belongs to that name. |
| 1.1.3 | "The Whitecaps" left in English | Translate the article before club nicknames. Gate for an English "The" + capital. |

## Spend (durable ledger `soccer_news_openai_usage`, nominal standard rates)

| Task | Calls | Input tokens | Output tokens | USD |
|---|---|---|---|---|
| translation | 16 | 27,085 | 19,703 | 0.2292 |
| translation_check | 15 | 33,734 | 6,253 | 0.1047 |
| **Pilot total** | 31 | | | **0.3339** (Spanish allowance: $1.00/day) |
| Whole newsroom, 2026-10-09 | 35 | 76,941 | 28,719 | 0.3781 (ceiling: $5.00/day) |

## Production verification

- **Reader API:** `GET /v1/news/:slug?locale=es` serves only a current, verified version. English pages list their
  Spanish twin in `translations`.
- **SEO:** each Spanish page is self-canonical with reciprocal en/es/x-default hreflang on both pages. JSON-LD carries
  `inLanguage` + `translationOfWork` / `workTranslation`. `sitemap-es-news.xml` lists only verified translations, and
  English-only stories keep the English canonical.
- **`scripts/qa/article-i18n.mjs`:**
  - first 2 articles: 44/44;
  - first 7: 152/154 (two chart labels and a credit line were untranslated; fixed in db6c5fa);
  - first 9 after the fix: 198/198.

## Rollback

- **Worker:** redeploy the previous soccer-news version (`docs/deployments.jsonl`).
- **Unpublish a translation:** in the database, set `status = 'withdrawn'` with `retired_at`, as the lifecycle allows.
  The English article is unaffected.
- **Stop all translation:** set `SOCCER_TRANSLATE_ES` to `off` (the lifecycle sweep keeps running).
