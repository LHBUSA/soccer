// RC2.1 (soccer-quality 2.1.1): lead_quality false positive. The gate counted only a decisive player's surname, "half-time"
// / "interval" or an ordinal minute as the lead's angle, so the owner-preferred Houston v Sporting KC lead (the packet's
// stored upset, 30th beating sixth, through a first-half contrast) held. Fixture = the real frozen packet + that candidate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, leadHasPosition, leadStatesPacketAngle, qualityGates, validateEditorial, QUALITY_VERSION } from '../workers/soccer-news/src/desk.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/news-houston-skc-2026-09-27.json', import.meta.url), 'utf8'));
const P = fx.packet;
const withLead = lead => ({ ...fx.candidate, sections: [{ ...fx.candidate.sections[0], paragraphs: [lead, ...fx.candidate.sections[0].paragraphs.slice(1)] }, ...fx.candidate.sections.slice(1)] });
const leadGate = article => qualityGates(article, P).find(r => r.gate === 'lead_quality');
const PREFERRED = fx.candidate.sections[0].paragraphs[0];

test('fixture is the real stored upset angle (30th beat 6th)', () => {
  assert.equal(QUALITY_VERSION, 'soccer-quality/2.1.1');
  assert.deepEqual(P.angles.find(a => a.key === 'upset').detail, { loser_position_before: 6, winner_position_before: 30 });
  assert.equal(P.match.winner, 'away');
  assert.match(PREFERRED, /30th place/); assert.match(PREFERRED, /sitting sixth/); assert.match(PREFERRED, /first-half/);
});

test('the owner-preferred Houston lead now passes lead_quality', () => {
  const g = leadGate(fx.candidate);
  assert.equal(g.pass, true, JSON.stringify(g));
  assert.equal(leadStatesPacketAngle(PREFERRED, P), true);
});

test('the same lead without its table-position context (and timing) fails', () => {
  const stripped = 'Sporting Kansas City left Shell Energy Stadium with a victory over Houston Dynamo FC. Houston Dynamo FC attempted seven shots, but Sporting Kansas City scored from each of its two efforts.';
  assert.equal(leadGate(withLead(stripped)).pass, false);
  // positions present but the beaten team not named: still no packet angle
  assert.equal(leadStatesPacketAngle('Sporting Kansas City arrived in 30th place and beat the side sitting sixth.', P), false);
  // only one of the two stored positions: no packet angle
  assert.equal(leadStatesPacketAngle('Sporting Kansas City, 30th, beat Houston Dynamo FC.', P), false);
});

test('bare template sentence and winner-only lead fail', () => {
  assert.equal(leadGate(withLead('Sporting Kansas City beat Houston Dynamo FC 2-0 on 27 September.')).pass, false);
  assert.equal(leadGate(withLead('Sporting Kansas City won at Shell Energy Stadium.')).pass, false);
});

test('first-half / second-half timing leads satisfy the angle requirement', () => {
  for (const lead of ['Sporting Kansas City won at Shell Energy Stadium on the strength of a decisive first-half spell against Houston Dynamo FC.',
    'Sporting Kansas City held on through a goalless second half to win at Houston Dynamo FC.',
    'Sporting Kansas City won it in the first half at Houston Dynamo FC.',
    'Sporting Kansas City protected their lead through a second-half siege by Houston Dynamo FC.']) assert.equal(leadGate(withLead(lead)).pass, true, lead);
});

test('no generic number escape hatch: arbitrary or wrong positions do not count', () => {
  assert.equal(leadStatesPacketAngle('Sporting Kansas City (29th) beat fifth-placed Houston Dynamo FC.', P), false, 'wrong positions');
  assert.equal(leadStatesPacketAngle('Sporting Kansas City won 30-6 on shots against Houston Dynamo FC.', P), false, 'bare numbers are not ordinals');
  assert.equal(leadHasPosition('a 6-0 win', 6), false); assert.equal(leadHasPosition('16th', 6), false); assert.equal(leadHasPosition('136th', 36), false);
  assert.equal(leadHasPosition('the sixth-placed side', 6), true); assert.equal(leadHasPosition('thirtieth', 30), true);
  assert.equal(leadGate(withLead('Sporting Kansas City (29th) beat fifth-placed Houston Dynamo FC.')).pass, false);
});

test('invented positions and numbers are still caught by the evidence gates (unchanged)', () => {
  // 22, 12 and 47 appear nowhere in this packet (the number gate is membership-based: a number present elsewhere in the
  // packet is grounded by it; that rule is unchanged here).
  const invented = withLead('Sporting Kansas City arrived in 22nd place and beat a Houston Dynamo FC side sitting 12th, ending 47 straight away defeats.');
  assert.equal(leadGate(invented).pass, false, 'wrong positions are no packet angle');
  const failed = validateEditorial(invented, P).filter(r => !r.pass).map(r => r.gate);
  assert.ok(failed.includes('new_number_not_in_packet'), JSON.stringify(failed));
  assert.deepEqual(validateEditorial(invented, P).find(r => r.gate === 'new_number_not_in_packet').detail.sort(), ['12th', '22nd', '47']);
});

test('the preferred candidate: complete gate result after the fix', () => {
  const j = judge(fx.candidate, P);
  const failed = [...(j.failed || [])];
  assert.ok(!failed.includes('lead_quality'), JSON.stringify(failed));
  // record the complete result for the release evidence
  console.log('HOUSTON_JUDGE', JSON.stringify({ pass: j.pass, failed }));
});
