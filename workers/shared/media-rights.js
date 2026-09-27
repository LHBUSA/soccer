// Per-file rights classification for Wikimedia Commons media. Pure: input is the
// Commons `extmetadata` of ONE file; output is the registry verdict. The rule is
// conservative — anything not clearly free for commercial use is not published.
//   approved         CC0 / public domain / CC BY / CC BY-SA (any version), author known
//   restricted       NC or ND licences (commercial use or adaptation not allowed)
//   rejected         non-free / fair use
//   review_required  everything else (GFDL-only, FAL, unknown, missing author, ...)
// Commons "Restrictions" (personality rights, trademarks) are recorded as notes.
// Owner policy lives in data/media/policy.json and is echoed into every row.

export const RIGHTS_VERSION = 'media-rights/1.0.0';

const v = (m, k) => (m?.[k]?.value ?? '').toString();

export function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyCommons(meta, { mediaType = 'portrait', fileUrl = null, policy = {} } = {}) {
  const short = v(meta, 'LicenseShortName').trim();
  const code = v(meta, 'License').trim().toLowerCase();
  const licenseUrl = v(meta, 'LicenseUrl').trim() || null;
  const author = stripHtml(v(meta, 'Artist')) || null;
  const nonFree = /^true$/i.test(v(meta, 'NonFree'));
  const restrictions = v(meta, 'Restrictions').split('|').map(s => s.trim()).filter(Boolean);
  const notes = [];
  if (restrictions.includes('personality')) notes.push('Commons: personality rights apply (editorial identification of the person only).');
  if (restrictions.includes('trademarked')) notes.push('Commons: depicts a trademark; used only to identify the club (nominative use).');
  for (const r of restrictions.filter(x => !['personality', 'trademarked'].includes(x))) notes.push(`Commons restriction: ${r}`);

  const isPd = /^(cc0|pd)/.test(code) || /public domain|^cc0/i.test(short);
  const isCc = /^cc-by(-sa)?-\d/.test(code) || /^cc by(-sa)? \d/i.test(short);
  const isNcNd = /-nc|-nd/.test(code) || /\b(nc|nd)\b/i.test(short);

  let status;
  if (nonFree) status = 'rejected';
  else if (isNcNd) status = 'restricted';
  else if (isPd || isCc) status = 'approved';
  else status = 'review_required';

  // CC licences require attribution: without a known author we do not publish.
  if (status === 'approved' && isCc && !author) { status = 'review_required'; notes.push('Author not stated in file metadata.'); }
  if (status === 'approved' && isCc && !licenseUrl) { status = 'review_required'; notes.push('Licence URL not stated in file metadata.'); }
  // A club emblem belongs to the club: a third party cannot licence it (CC0 / CC BY on a
  // user "update" of a crest is licence-washing). Crests pass only when Commons treats the
  // file itself as public domain (e.g. text logo / below the threshold of originality).
  if (status === 'approved' && mediaType === 'crest' && !/^pd/.test(code) && !/public domain/i.test(short)) {
    status = 'review_required'; notes.push('Crest under a third-party licence: the club owns the emblem, so the licence cannot be verified.');
  }
  if (status === 'approved' && mediaType === 'crest' && restrictions.includes('trademarked') && policy.crest_trademark === 'review') {
    status = 'review_required'; notes.push('Owner policy: trademarked crests need review.');
  }
  const license = short || (isPd ? 'Public domain' : null);
  return {
    rights_status: status,
    license,
    license_url: licenseUrl || (isPd && fileUrl ? fileUrl : null),
    author,
    attribution: license ? `${author ? `${author}, ` : ''}${license}, via Wikimedia Commons` : null,
    rights_notes: [`${RIGHTS_VERSION}`, ...notes].join(' '),
  };
}
