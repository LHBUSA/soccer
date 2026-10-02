// PBE EDITORIAL ART ENGINE (soccer, v0 contact-sheet stage — NOT wired into production).
// Pure: art spec (built only from canonical story data) -> SVG string. Deterministic: the same spec,
// direction and format always produce byte-identical SVG, so an asset can be content-hashed and frozen.
//
// Boundary (owner brief 2026-10-02): no photographs, no likeness of any real person, no faces, no crests,
// league logos, sponsor marks, kit designs or club colours. Human figures are ORIGINAL, faceless,
// constructed athletes (thick-stroke limbs on joint skeletons) in the PBE home-gold / away-ice pair also
// used by PBEcast — never a team's colours. Names, scores and numbers are factual text from the spec.
// media_kind for anything produced here: 'pbe_editorial_art' (never 'photo').

export const ART_ENGINE_VERSION = 'pbe-art-soccer/0.1.0';
export const FORMATS = { hero: [1600, 900], og: [1200, 630], square: [1080, 1080], story: [1080, 1920] };
export const DIRECTIONS = ['poster', 'pitch', 'broadcast'];

const C = { night: '#060d1a', navy: '#0a1628', navy2: '#12233d', line: '#233a60', gold: '#d4a73a', gold2: '#f0c65a', ice: '#cfe0f5', ice2: '#8fb4e6', white: '#ffffff', mute: '#9aa9c2', red: '#e5484d', green: '#31c48d', draw: '#8a94a6' };
const DISPLAY = "'Barlow Condensed','Arial Narrow',sans-serif"; const BODY = "'Inter',Arial,sans-serif"; const MONO = "'JetBrains Mono',Consolas,monospace";
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r = n => Math.round(n * 10) / 10;
// Barlow Condensed 800 uppercase averages ~0.47 em per glyph: fit a line into a width.
const fit = (text, maxW, maxSize, k = 0.47) => Math.max(10, Math.min(maxSize, maxW / Math.max(1, String(text).length * k)));
const T = (x, y, s, text, { size = 40, font = DISPLAY, weight = 800, fill = C.white, anchor = 'start', ls = 0, op = 1 } = {}) =>
  `<text x="${r(x)}" y="${r(y)}" font-family="${font}" font-size="${r(size)}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls ? ` letter-spacing="${r(ls)}"` : ''}${op !== 1 ? ` opacity="${op}"` : ''}${s ? ` ${s}` : ''}>${esc(text)}</text>`;

// ---------------------------------------------------------------- original figures
// Joint skeletons in a unit box (height 1, y down, facing right). Limbs are rendered as tapered strokes.
const POSES = {
  strike: { head: [-0.03, 0.075], neck: [-0.02, 0.16], sh: [[-0.1, 0.2], [0.08, 0.2]], arms: [[[-0.22, 0.3], [-0.31, 0.23]], [[0.18, 0.3], [0.25, 0.41]]], hip: [[-0.05, 0.53], [0.06, 0.53]], legs: [[[-0.07, 0.75], [-0.1, 0.97]], [[0.2, 0.66], [0.38, 0.6]]], ball: [0.46, 0.6] },
  run: { head: [0.05, 0.075], neck: [0.03, 0.16], sh: [[-0.07, 0.2], [0.11, 0.2]], arms: [[[-0.16, 0.31], [-0.09, 0.42]], [[0.21, 0.28], [0.28, 0.18]]], hip: [[-0.04, 0.53], [0.06, 0.53]], legs: [[[-0.16, 0.7], [-0.31, 0.8]], [[0.2, 0.68], [0.17, 0.94]]] },
  celebrate: { head: [0, 0.075], neck: [0, 0.16], sh: [[-0.09, 0.2], [0.09, 0.2]], arms: [[[-0.18, 0.08], [-0.23, -0.05]], [[0.18, 0.08], [0.23, -0.05]]], hip: [[-0.05, 0.53], [0.05, 0.53]], legs: [[[-0.1, 0.75], [-0.15, 0.98]], [[0.11, 0.74], [0.16, 0.97]]] },
  stand: { head: [0, 0.075], neck: [0, 0.16], sh: [[-0.1, 0.2], [0.1, 0.2]], arms: [[[-0.17, 0.33], [-0.08, 0.46]], [[0.17, 0.33], [0.08, 0.46]]], hip: [[-0.06, 0.53], [0.06, 0.53]], legs: [[[-0.07, 0.75], [-0.08, 0.98]], [[0.07, 0.75], [0.08, 0.98]]] },
};
export function figure(pose, { x, y, h, face = 1, color = C.gold, op = 1, id = 'f' }) {
  // Dark athletic silhouette with an accent rim light and a soft accent glow: every limb is drawn
  // three times (blurred glow, accent rim, dark body) so the figure reads as key-art, not a pictogram.
  const P = POSES[pose] || POSES.stand;
  const pt = ([px, py]) => [r(x + face * px * h), r(y + py * h)];
  const seg = (a, b, w) => { const [A, B] = [pt(a), pt(b)]; return { d: `M${A[0]} ${A[1]} L${B[0]} ${B[1]}`, w: w * h }; };
  const [ls, rs] = P.sh; const [lh, rh] = P.hip;
  const segs = [
    seg(lh, P.legs[0][0], 0.082), seg(P.legs[0][0], P.legs[0][1], 0.066), seg(ls, P.arms[0][0], 0.054), seg(P.arms[0][0], P.arms[0][1], 0.044),
    seg(rh, P.legs[1][0], 0.086), seg(P.legs[1][0], P.legs[1][1], 0.068), seg(rs, P.arms[1][0], 0.054), seg(P.arms[1][0], P.arms[1][1], 0.044),
    seg([P.neck[0], P.neck[1] + 0.05], [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2 - 0.03], 0.15), seg(ls, rs, 0.075), seg(ls, lh, 0.06), seg(rs, rh, 0.06), seg(lh, rh, 0.09), seg(P.neck, P.head, 0.05),
  ];
  const head = pt(P.head); const hr = 0.06 * h;
  const torso = [ls, rs, rh, lh].map(pt).map(p => p.join(' ')).join(' L');
  const draw = (extra, colr, sw) => `<path d="M${torso} Z" fill="${colr}" stroke="${colr}" stroke-width="${r(0.06 * h + sw)}" stroke-linejoin="round"/>` + segs.map(g => `<path d="${g.d}" stroke="${colr}" stroke-width="${r(g.w + sw)}" stroke-linecap="round"/>`).join('') + `<circle cx="${head[0]}" cy="${head[1]}" r="${r(hr + sw / 2)}" fill="${colr}"/>`;
  const ball = P.ball ? (() => { const b = pt(P.ball); const br = r(0.042 * h); return `<circle cx="${b[0]}" cy="${b[1]}" r="${br}" fill="#f4f7fb"/><circle cx="${b[0]}" cy="${b[1]}" r="${r(br * 0.42)}" fill="${C.navy}" fill-opacity=".85"/>`; })() : '';
  return `<defs><filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(0.035 * h)}"/></filter><linearGradient id="${id}d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16263f"/><stop offset="1" stop-color="#050b16"/></linearGradient></defs>
    <g opacity="${op}" fill="none"><g filter="url(#${id}b)" opacity=".55">${draw(0, color, 0.02 * h)}</g><g>${draw(0, color, 0.014 * h)}</g><g>${draw(0, `url(#${id}d)`, 0)}</g>${ball}</g>`;
}

// ---------------------------------------------------------------- shared pieces
const grain = (W, H) => `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .05 0"/></filter><rect width="${W}" height="${H}" filter="url(#grain)"/>`;
const pitchLines = (x, y, w, h, op = 0.16, stroke = C.white) => {
  const sx = w / 105; const sy = h / 68; const L = (a, b, c, d) => `<line x1="${r(x + a * sx)}" y1="${r(y + b * sy)}" x2="${r(x + c * sx)}" y2="${r(y + d * sy)}"/>`;
  return `<g stroke="${stroke}" stroke-opacity="${op}" stroke-width="${r(Math.max(1.2, w / 700))}" fill="none"><rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"/>${L(52.5, 0, 52.5, 68)}<circle cx="${r(x + 52.5 * sx)}" cy="${r(y + 34 * sy)}" r="${r(9.15 * sx)}"/><rect x="${r(x)}" y="${r(y + 13.84 * sy)}" width="${r(16.5 * sx)}" height="${r(40.32 * sy)}"/><rect x="${r(x + 88.5 * sx)}" y="${r(y + 13.84 * sy)}" width="${r(16.5 * sx)}" height="${r(40.32 * sy)}"/></g>`;
};
const brand = (x, y, size, color = C.gold) => `${T(x, y, '', 'PROPBETEDGE', { size, fill: color, ls: size * 0.18 })}${T(x, y + size * 1.15, '', 'SOCCER INTELLIGENCE', { size: size * 0.55, font: BODY, weight: 700, fill: C.mute, ls: size * 0.12 })}`;
const formTiles = (x, y, s, form, gap = 0.22) => form.map((f, i) => `<rect x="${r(x + i * s * (1 + gap))}" y="${r(y)}" width="${r(s)}" height="${r(s)}" rx="${r(s * 0.16)}" fill="${f === 'W' ? C.green : f === 'L' ? C.red : C.draw}"/>${T(x + i * s * (1 + gap) + s / 2, y + s * 0.7, '', f, { size: s * 0.6, anchor: 'middle', fill: C.night })}`).join('');
const kicker = (x, y, size, parts, color = C.gold2) => T(x, y, '', parts.filter(Boolean).join('  ·  ').toUpperCase(), { size, font: BODY, weight: 800, fill: color, ls: size * 0.16 });

// Background per direction.
function ground(dir, W, H, s) {
  const base = `<rect width="${W}" height="${H}" fill="${C.night}"/>`;
  if (dir === 'poster') return `${base}<defs><radialGradient id="gl" cx=".18" cy=".35" r=".7"><stop offset="0" stop-color="${C.gold}" stop-opacity=".34"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient><radialGradient id="gr" cx=".85" cy=".7" r=".65"><stop offset="0" stop-color="${C.ice2}" stop-opacity=".28"/><stop offset="1" stop-color="${C.ice2}" stop-opacity="0"/></radialGradient><linearGradient id="fl" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="${C.night}" stop-opacity="0"/><stop offset="1" stop-color="${C.night}" stop-opacity=".9"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#gl)"/><rect width="${W}" height="${H}" fill="url(#gr)"/>${Array.from({ length: 9 }, (_, i) => `<line x1="${r(W * (i / 8))}" y1="0" x2="${r(W * (i / 8) - H * 0.35)}" y2="${H}" stroke="${C.white}" stroke-opacity=".035" stroke-width="${r(W / 60)}"/>`).join('')}`;
  if (dir === 'pitch') return `${base}<defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d2a22"/><stop offset="1" stop-color="${C.night}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#pg)"/>`;
  return `${base}<defs><linearGradient id="bh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.gold}"/><stop offset="1" stop-color="#9c7419"/></linearGradient><linearGradient id="ba" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b5c86"/><stop offset="1" stop-color="${C.ice2}"/></linearGradient></defs><polygon points="0,0 ${r(W * 0.56)},0 ${r(W * 0.44)},${H} 0,${H}" fill="${C.navy2}"/><polygon points="${r(W * 0.56)},0 ${W},0 ${W},${H} ${r(W * 0.44)},${H}" fill="${C.navy}"/><polygon points="${r(W * 0.535)},0 ${r(W * 0.56)},0 ${r(W * 0.44)},${H} ${r(W * 0.415)},${H}" fill="url(#bh)" opacity=".9"/>`;
}

// ---------------------------------------------------------------- templates
// spec.kind: preview | report | team_trend | player_form | table
export function renderArt(spec, { direction = 'poster', format = 'hero' } = {}) {
  const [W, H] = FORMATS[format]; const s = Math.min(W, H) / 900; const tall = H > W * 1.2; const wide = W / H > 1.5;
  const pad = 64 * s; const parts = [ground(direction, W, H, s)];
  const kick = [spec.competition, spec.stage, spec.label];
  const put = x => parts.push(x);
  if (spec.kind === 'preview' || spec.kind === 'report') {
    const home = spec.home; const away = spec.away;
    const figH = tall ? H * 0.34 : H * (direction === 'pitch' ? 0.5 : 0.82);
    if (direction === 'pitch') {
      const pw = tall ? W - pad * 2 : W * 0.56; const ph = pw * 68 / 105; const px = tall ? pad : W - pw - pad; const py = tall ? H * 0.42 : (H - ph) / 2 + 24 * s;
      put(pitchLines(px, py, pw, ph, 0.22));
      for (const sh of spec.shots || []) put(`<circle cx="${r(px + sh.x / 105 * pw)}" cy="${r(py + sh.y / 68 * ph)}" r="${r((sh.goal ? 13 : 7) * s)}" fill="${sh.team === 'home' ? C.gold : C.ice}" fill-opacity="${sh.goal ? 1 : 0.55}"${sh.goal ? ` stroke="${C.white}" stroke-width="${r(3 * s)}"` : ''}/>`);
      if (!(spec.shots || []).length) put(figure('run', { x: px + pw * 0.3, y: py + ph * 0.08, h: ph * 0.84, color: C.gold, id: 'ph', op: 0.9 }) + figure('run', { x: px + pw * 0.7, y: py + ph * 0.08, h: ph * 0.84, face: -1, color: C.ice, id: 'pa', op: 0.9 }));
    } else if (direction === 'poster') {
      put(figure(spec.kind === 'report' ? 'celebrate' : 'strike', { x: W * (tall ? 0.3 : 0.24), y: tall ? H * 0.34 : H * 0.1, h: figH, color: C.gold, id: 'h', op: 0.92 }));
      put(figure(spec.kind === 'report' ? 'stand' : 'run', { x: W * (tall ? 0.72 : 0.78), y: tall ? H * 0.37 : H * 0.14, h: figH * 0.92, face: -1, color: C.ice, id: 'a', op: 0.85 }));
      put(`<rect width="${W}" height="${H}" fill="url(#fl)"/>`);
    } else {
      put(figure('strike', { x: W * 0.2, y: tall ? H * 0.32 : H * 0.16, h: tall ? H * 0.3 : H * 0.78, color: C.gold2, id: 'h', op: 0.95 }));
      put(figure('run', { x: W * 0.8, y: tall ? H * 0.34 : H * 0.18, h: tall ? H * 0.28 : H * 0.74, face: -1, color: C.ice, id: 'a', op: 0.95 }));
    }
    put(kicker(pad, pad + 18 * s, 22 * s, kick));
    // names + centre
    const nameMax = tall ? W - pad * 2 : (direction === 'pitch' ? W * 0.36 : W * 0.4);
    const ny = tall ? H * 0.13 : direction === 'pitch' ? H * 0.36 : H * 0.62;
    const hs = fit(home.name, nameMax, 150 * s); const as = fit(away.name, nameMax, 150 * s);
    if (direction === 'pitch' || tall) {
      put(T(pad, ny, '', home.name.toUpperCase(), { size: hs, fill: C.gold2 }));
      const mx = Math.max(hs, as); const rep = spec.kind === 'report';
      put(T(pad, ny + mx * (rep ? 0.98 : 0.62), '', rep ? `${spec.score.home}–${spec.score.away}` : 'V', { size: mx * (rep ? 0.9 : 0.4), fill: rep ? C.white : C.mute, font: rep ? MONO : DISPLAY, weight: rep ? 700 : 800 }));
      put(T(pad, ny + mx * (rep ? 1.92 : 1.42), '', away.name.toUpperCase(), { size: as, fill: C.ice }));
    } else {
      put(T(pad, ny, '', home.name.toUpperCase(), { size: hs, fill: C.gold2 }));
      put(T(W - pad, ny, '', away.name.toUpperCase(), { size: as, fill: C.ice, anchor: 'end' }));
      if (spec.kind === 'report') put(`<rect x="${r(W / 2 - 150 * s)}" y="${r(ny - 118 * s)}" width="${r(300 * s)}" height="${r(140 * s)}" rx="${r(18 * s)}" fill="${C.night}" fill-opacity=".86" stroke="${C.gold}" stroke-width="${r(2 * s)}"/>${T(W / 2, ny, '', `${spec.score.home}–${spec.score.away}`, { size: 120 * s, font: MONO, weight: 700, anchor: 'middle' })}`);
      else put(T(W / 2, ny - 10 * s, '', 'V', { size: 70 * s, anchor: 'middle', fill: C.mute }));
    }
    // data strip
    const sy = tall ? H * 0.78 : H - pad - 74 * s;
    const lines = spec.kind === 'preview'
      ? [[home.standing, away.standing], [home.form, away.form]]
      : [[spec.events?.home || '', spec.events?.away || '']];
    if (spec.kind === 'preview') {
      put(T(pad, sy, '', home.standing, { size: 34 * s, font: BODY, weight: 800, fill: C.white }));
      put(formTiles(pad, sy + 18 * s, 34 * s, home.form));
      put(T(tall ? pad : W - pad, tall ? sy + 120 * s : sy, '', away.standing, { size: 34 * s, font: BODY, weight: 800, fill: C.white, anchor: tall ? 'start' : 'end' }));
      put(formTiles(tall ? pad : W - pad - away.form.length * 34 * s * 1.22 + 34 * s * 0.22, tall ? sy + 138 * s : sy + 18 * s, 34 * s, away.form));
    } else {
      // goal timeline: 0..90 bar with goal + red-card markers (source minutes)
      const bx = pad; const bw = W - pad * 2; const by = sy + 10 * s;
      put(`<line x1="${r(bx)}" y1="${r(by)}" x2="${r(bx + bw)}" y2="${r(by)}" stroke="${C.white}" stroke-opacity=".35" stroke-width="${r(3 * s)}"/>${T(bx, by + 34 * s, '', "0'", { size: 18 * s, font: MONO, fill: C.mute })}${T(bx + bw, by + 34 * s, '', "90'", { size: 18 * s, font: MONO, fill: C.mute, anchor: 'end' })}`);
      for (const e of spec.timeline || []) {
        const ex = bx + Math.min(1, e.minute / 95) * bw; const col = e.team === 'home' ? C.gold : C.ice;
        if (e.type === 'goal' || e.type === 'own_goal') put(`<circle cx="${r(ex)}" cy="${r(by)}" r="${r(11 * s)}" fill="${col}" stroke="${C.night}" stroke-width="${r(3 * s)}"/>${T(ex, by - 22 * s, '', `${e.label} ${e.display}`, { size: 22 * s, font: BODY, weight: 700, anchor: 'middle', fill: col })}`);
        if (e.type === 'card_red') put(`<rect x="${r(ex - 6 * s)}" y="${r(by - 12 * s)}" width="${r(12 * s)}" height="${r(18 * s)}" rx="${r(2 * s)}" fill="${C.red}"/>`);
      }
    }
    put(T(tall ? pad : W - pad, tall ? sy - 70 * s : pad + 18 * s, '', spec.when, { size: 20 * s, font: BODY, weight: 700, fill: C.mute, anchor: tall ? 'start' : 'end', ls: 2 * s }));
  } else if (spec.kind === 'team_trend' || spec.kind === 'player_form') {
    const isP = spec.kind === 'player_form';
    if (direction !== 'pitch') put(figure(isP ? 'strike' : 'run', { x: W * (tall ? 0.55 : 0.72), y: tall ? H * 0.36 : H * 0.08, h: tall ? H * 0.42 : H * 0.88, color: direction === 'broadcast' ? C.gold2 : C.gold, id: 'p', op: direction === 'poster' ? 0.9 : 0.97, face: -1 }));
    else put(pitchLines(tall ? pad : W * 0.48, tall ? H * 0.46 : H * 0.18, tall ? W - pad * 2 : W * 0.46, (tall ? W - pad * 2 : W * 0.46) * 68 / 105, 0.2));
    if (direction === 'poster') put(`<rect width="${W}" height="${H}" fill="url(#fl)"/>`);
    put(kicker(pad, pad + 18 * s, 22 * s, kick));
    const maxW = tall ? W - pad * 2 : W * 0.56;
    const ts = fit(spec.title, maxW, 132 * s);
    put(T(pad, tall ? H * 0.16 : H * 0.32, '', spec.title.toUpperCase(), { size: ts, fill: C.white }));
    if (spec.subtitle) put(T(pad, (tall ? H * 0.16 : H * 0.32) + 54 * s, '', spec.subtitle, { size: 30 * s, font: BODY, weight: 700, fill: C.mute }));
    // the number
    put(T(pad, tall ? H * 0.36 : H * 0.62, '', String(spec.big), { size: 210 * s, font: MONO, weight: 700, fill: C.gold2 }));
    put(T(pad + String(spec.big).length * 210 * s * 0.6 + 28 * s, tall ? H * 0.36 : H * 0.62, '', spec.bigLabel.toUpperCase(), { size: fit(spec.bigLabel, maxW * 0.55, 46 * s), fill: C.white }));
    // run strip
    const items = spec.run || []; const cw = Math.min(110 * s, (maxW) / Math.max(1, items.length) - 10 * s);
    items.forEach((it, i) => {
      const x = pad + i * (cw + 10 * s); const y = tall ? H * 0.4 : H - pad - 120 * s;
      put(`<rect x="${r(x)}" y="${r(y)}" width="${r(cw)}" height="${r(96 * s)}" rx="${r(10 * s)}" fill="${it.result === 'W' ? C.green : it.result === 'L' ? C.red : it.result === 'D' ? C.draw : C.navy2}" fill-opacity="${it.result ? 0.9 : 1}" stroke="${C.gold}" stroke-opacity="${it.result ? 0 : 0.8}"/>`);
      put(T(x + cw / 2, y + 42 * s, '', it.top, { size: 34 * s, anchor: 'middle', fill: it.result ? C.night : C.gold2, font: MONO, weight: 700 }));
      put(T(x + cw / 2, y + 78 * s, '', it.bottom, { size: 15 * s, anchor: 'middle', fill: it.result ? C.night : C.mute, font: BODY, weight: 700 }));
    });
    put(T(pad, tall ? H * 0.4 + 140 * s : H - pad - 140 * s, '', spec.when, { size: 20 * s, font: BODY, weight: 700, fill: C.mute, ls: 2 * s }));
  } else if (spec.kind === 'table') {
    put(kicker(pad, pad + 18 * s, 22 * s, kick));
    put(T(pad, pad + 120 * s, '', spec.title.toUpperCase(), { size: fit(spec.title, W - pad * 2, 110 * s), fill: C.white }));
    put(T(pad, pad + 168 * s, '', spec.when, { size: 18 * s, font: BODY, weight: 700, fill: C.mute, ls: 2 * s }));
    const rows = spec.rows || []; const top = pad + 210 * s; const rh = Math.min(110 * s, (H - top - pad * 1.6) / Math.max(1, rows.length));
    const maxPts = Math.max(1, ...rows.map(x => x.points));
    rows.forEach((row, i) => {
      const y = top + i * rh; const bw = (W - pad * 2) * (direction === 'pitch' ? 0.62 : 0.72) * (row.points / maxPts);
      const col = i < (spec.advance || 0) ? C.gold : C.ice2;
      put(`<rect x="${r(pad)}" y="${r(y)}" width="${r(W - pad * 2)}" height="${r(rh * 0.72)}" rx="${r(8 * s)}" fill="${C.white}" fill-opacity=".05"/><rect x="${r(pad)}" y="${r(y)}" width="${r(Math.max(bw, 8 * s))}" height="${r(rh * 0.72)}" rx="${r(8 * s)}" fill="${col}" fill-opacity="${direction === 'broadcast' ? 0.55 : 0.4}"/><rect x="${r(pad)}" y="${r(y)}" width="${r(6 * s)}" height="${r(rh * 0.72)}" fill="${col}"/>`);
      put(T(pad + 22 * s, y + rh * 0.5, '', `${row.position}`, { size: rh * 0.42, font: MONO, weight: 700, fill: col }));
      put(T(pad + 70 * s, y + rh * 0.5, '', row.name.toUpperCase(), { size: fit(row.name, (W - pad * 2) * 0.42, rh * 0.48), fill: C.white }));
      put(T(W - pad, y + rh * 0.5, '', `${row.points} PTS`, { size: rh * 0.4, font: MONO, weight: 700, fill: C.white, anchor: 'end' }));
      const ts2 = rh * 0.42; put(formTiles(W - pad - 190 * s - (row.form || []).length * ts2 * 1.22, y + rh * 0.08, ts2, row.form || []));
    });
    if (direction !== 'pitch') put(figure('celebrate', { x: W * 0.86, y: H * 0.02, h: H * 0.3, color: C.gold, id: 't', op: 0.18 }));
  }
  put(brand(tall ? pad : W - pad - 250 * s, H - pad * (tall ? 1.1 : 0.62) - 14 * s, 26 * s));
  if (direction !== 'pitch') put(`<g opacity=".7">${grain(W, H)}</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-engine="${ART_ENGINE_VERSION}" data-direction="${direction}" data-format="${format}">${parts.join('')}</svg>`;
}
