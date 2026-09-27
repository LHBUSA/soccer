# Vision

PropBetEdge Soccer Intelligence is an **owned soccer data graph** and an
**event-level model of the field**. On top of that sit proprietary analytics,
PBEcast, Soccer DNA and evidence-backed news. Prediction and market intelligence
come later.

## What makes it different

**Deep spatial intelligence.** Every stored event has a place on one canonical
105 × 68 m pitch. The surfaces that matter most are:
- shot maps
- progression
- territory
- pressing
- possession chains
- playback

Most scores products never reach those. The visual language is the pitch, not
the league table.

## What it is not

- It is not a scores site, and not a clone of ESPN, FotMob or SofaScore.
- It is not an odds scraper, and not a picks-only product.
- It is not a frontend whose data disappears when a provider has an outage. Production pages read PropBetEdge infrastructure only.

## Flywheel

```
Google / X -> soccer story -> player / team / match intelligence -> PBEcast / DNA -> All Access
```

News launches before predictions. The descriptive layer earns trust and search
traffic while xG, xT, possession value and Soccer DNA are researched underneath.
The prediction model only comes after that layer is trustworthy
(`docs/MODEL_READINESS.md`).

## Principles

1. **Own the data.** Capture raw payloads, archive them, and normalize and store every accepted entity ourselves.
2. **Evidence over coverage.** A league we cannot source legitimately is a league we do not claim.
3. **Values first, confidence second, percentiles last.** Percentiles appear only once populations are mature, as in the Tennis DNA rules.
4. **Never fake it:**
   - no fake xG
   - no fake playback
   - no implied player tracking
   - no hallucinated stats, injuries or quotes
5. **Fail closed.** Ambiguous identity is queued, and a partial proof writes nothing.
