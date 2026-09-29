-- soccer-news OpenAI usage ledger: Newsroom V4 routing fields (soccer-ai-router/1.0.0). Additive only: nullable
-- columns on public.soccer_news_openai_usage (migration 20260929001100). No row, trigger, policy, grant or RLS setting
-- changes; the table stays append-only and service-role only. Existing rows keep NULL routing fields (no backfill —
-- they predate the router). The Worker writes these columns only when SOCCER_LEDGER_ROUTING=on, set after this applies.
--
-- sport / worker            constant provenance ('soccer' / 'soccer-news')
-- story_class               the frozen packet's event kind
-- routing_lane / reason     the router's decision (DETERMINISTIC never reaches the API, so never appears here)
-- pool                      the shared OpenAI pool the model draws on (premium | volume)
-- router_version            e.g. soccer-ai-router/1.0.0
-- latency_ms                request wall time
-- nominal_standard_cost     standard-rate equivalent (same value as estimated_usd). Nominal standard-rate estimate only;
--                           not evidence of actual billing. Complimentary shared-token usage may apply subject to
--                           eligibility and remaining daily allowance.

begin;

do $$
begin
  if to_regclass('public.soccer_news_openai_usage') is null then
    raise exception 'requires 20260929001100 (soccer_news_openai_usage)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

alter table public.soccer_news_openai_usage
  add column sport                 text check (sport is null or sport = 'soccer'),
  add column worker                text check (worker is null or worker = 'soccer-news'),
  add column story_class           text,
  add column routing_lane          text check (routing_lane is null or routing_lane in ('VOLUME','STANDARD_EDITORIAL','FLAGSHIP_EDITORIAL')),
  add column routing_reason        text,
  add column pool                  text check (pool is null or pool in ('premium','volume')),
  add column router_version        text,
  add column latency_ms            integer check (latency_ms is null or latency_ms >= 0),
  add column nominal_standard_cost numeric(12,6) check (nominal_standard_cost is null or nominal_standard_cost >= 0);

create index soccer_news_openai_usage_lane on public.soccer_news_openai_usage (routing_lane, occurred_at);

commit;
