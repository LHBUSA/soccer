// Formatting. The one rule: a missing value is shown as missing ("—"), never as 0.
export const DASH = '—';

export function num(v, { dp = 0, suffix = '' } = {}) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return DASH;
  const n = Number(v);
  return `${dp ? n.toFixed(dp) : Math.round(n).toLocaleString('en-US')}${suffix}`;
}

export function pct(part, total) {
  if (part === null || part === undefined || !total) return DASH;
  return `${Math.round((1000 * part) / total) / 10}%`;
}

const tz = 'UTC';
export function dateLong(iso) {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
}
export function dateShort(iso) {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz });
}
export function time(iso) {
  if (!iso) return '';
  return `${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })} UTC`;
}
export function dateTime(iso) {
  if (!iso) return DASH;
  return `${dateLong(iso)} · ${time(iso)}`;
}
export function ago(iso, now = Date.now()) {
  if (!iso) return 'unknown';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return dateShort(iso);
}

export const STATUS = {
  finished: 'Full time', live: 'Live', scheduled: 'Scheduled', postponed: 'Postponed',
  cancelled: 'Cancelled', abandoned: 'Abandoned', unknown: 'Awaiting result',
};
export const statusLabel = s => STATUS[s] || 'Awaiting result';

export function scoreline(score) {
  if (!score || score.home === null || score.home === undefined) return null;
  return `${score.home}–${score.away}`;
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export const ROLE = { goalkeeper: 'Goalkeeper', defender: 'Defender', midfielder: 'Midfielder', forward: 'Forward' };
export const FOOT = { left: 'Left', right: 'Right', both: 'Both' };

// Stat keys as the API exposes them. Derived = pbe-counts from our own event
// ledger; source = facts supplied by the provider (e.g. ESPN). Never mixed.
export const STAT_LABELS = {
  source: [
    ['possession_pct', 'Possession', '%'], ['shots', 'Shots'], ['shots_on_target', 'Shots on target'],
    ['provider_xg_espn', 'xG (supplied)', '', 2], ['passes', 'Passes'], ['passes_completed', 'Accurate passes'],
    ['corners', 'Corners'], ['fouls_committed', 'Fouls'], ['offsides', 'Offsides'], ['tackles', 'Tackles'],
    ['interceptions', 'Interceptions'], ['clearances', 'Clearances'], ['saves', 'Saves'],
    ['yellow_cards', 'Yellow cards'], ['red_cards', 'Red cards'],
  ],
  derived: [
    ['shots', 'Shots'], ['shots_on_target', 'Shots on target'], ['passes', 'Passes'], ['passes_completed', 'Passes completed'],
    ['final_third_passes_completed', 'Final-third passes completed'], ['crosses', 'Crosses'], ['duels', 'Duels'], ['duels_won', 'Duels won'],
    ['corners', 'Corners'], ['fouls_committed', 'Fouls'], ['offsides', 'Offsides'], ['yellow_cards', 'Yellow cards'], ['red_cards', 'Red cards'],
  ],
};

export function statsHeading(stats) {
  if (!stats) return null;
  if (stats.basis === 'derived') return { title: 'PBE DERIVED COUNTS', note: `Counted by PropBetEdge from the event ledger${stats.derivation ? ` (${stats.derivation})` : ''}.` };
  if (stats.basis === 'source') return { title: 'SOURCE MATCH STATISTICS', note: 'Supplied match statistics (DATA · PropSports). Not PropBetEdge metrics.' };
  return null;
}

export const COVERAGE = {
  ok: { label: 'FULL', tone: 'full' }, partial: { label: 'PARTIAL', tone: 'partial' },
  unavailable: { label: 'UNAVAILABLE', tone: 'unavailable' }, degraded: { label: 'DEGRADED', tone: 'degraded' },
};
export const coverageOf = meta => COVERAGE[meta?.coverage?.state] || { label: 'UNKNOWN', tone: 'unavailable' };

// Customer source labels (network standard DATA · PropSports): collection lanes read PropSports; the CC BY research
// dataset keeps its licence name. Licence credits for Wyscout (CC BY) and OpenLigaDB (ODbL) live in the footer.
export const SOURCE_NAMES = { openligadb: 'PropSports', wyscout: 'Wyscout public dataset', wyscout_figshare: 'Wyscout public dataset', espn: 'PropSports', pbe: 'PropSports', PropSports: 'PropSports' };
export const sourceName = s => SOURCE_NAMES[s] || s || DASH;
