// OPTIONAL LLM editorial pass. Off unless env.NEWS_LLM === 'on' and an API key is
// bound. The model receives ONLY the frozen packet and the template draft, may only
// rephrase (same section keys, same facts, same entities), and its output must pass
// the identical gates against the identical packet; otherwise the template article
// is published instead and the rejection is recorded on the article.
export const EDITOR = 'llm-editor/1.0.0';
const MODEL = 'claude-sonnet-5';

const INSTRUCTIONS = `You edit a soccer news draft for readability. Rules:
- Use ONLY facts in the PACKET. Do not add any number, name, date or claim that is not in it.
- Keep every section key, keep the "method" section text unchanged, keep all attribution sentences.
- No quotes, injuries, suspensions, transfers or rumours, odds or betting, records or "historic", mental-state claims, possession, xG.
- Keep the headline under 100 characters and keep the final score in it.
Return JSON only: {"headline": "...", "dek": "...", "sections": [{"key": "...", "heading": "...", "paragraphs": ["..."]}]}.`;

export function llmEnabled(env) { return env?.NEWS_LLM === 'on' && !!env?.ANTHROPIC_API_KEY; }

export async function editorialPass(draft, packet, env, { fetcher = fetch } = {}) {
  if (!llmEnabled(env)) return null;
  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: INSTRUCTIONS, messages: [{ role: 'user', content: `PACKET:\n${JSON.stringify(packet)}\n\nDRAFT:\n${JSON.stringify({ headline: draft.headline, dek: draft.dek, sections: draft.sections })}` }] }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const txt = (j.content || []).map(c => c.text || '').join('');
  let out; try { out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { return null; }
  if (!out?.headline || !Array.isArray(out.sections)) return null;
  const keys = draft.sections.map(s => s.key).join(',');
  if (out.sections.map(s => s.key).join(',') !== keys) return null; // structure must be preserved
  const method = draft.sections.find(s => s.key === 'method');
  return { ...draft, headline: out.headline, dek: out.dek || draft.dek, sections: out.sections.map(s => (s.key === 'method' ? method : { key: s.key, heading: String(s.heading), paragraphs: s.paragraphs.map(String) })), composer: `${draft.composer}+${EDITOR}` };
}
