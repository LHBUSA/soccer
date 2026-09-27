"""Licence evidence for open datasets that publish their licence as a file.

Writes docs/evidence/source-audit/<date>/licenses.json with, per source: the
licence file URL, its sha256, the SPDX id GitHub reports, and verbatim clause
excerpts (PDF text extracted with pypdf). Run from the repo root:
    python scripts/evidence/licenses.py
"""
import datetime, hashlib, io, json, pathlib, re, urllib.request

UA = {'User-Agent': 'PropBetEdgeSourceAudit/0.1 (+https://propbetedge.ai/sources)'}

def get(url):
    # Python's TLS stack is reset by the network on this workstation for
    # GitHub hosts while Node's fetch is not, so downloads go through Node.
    import subprocess, tempfile, os
    fd, tmp = tempfile.mkstemp(); os.close(fd)
    js = ("fetch(process.argv[1],{headers:{'user-agent':process.argv[3]}}).then(async r=>{"
          "require('fs').writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()));console.log(r.status)})")
    status = int(subprocess.run(['node', '-e', js, url, tmp, UA['User-Agent']], capture_output=True, text=True, check=True).stdout.strip())
    body = pathlib.Path(tmp).read_bytes(); os.remove(tmp)
    return status, body

def gh_license(repo):
    status, body = get(f'https://api.github.com/repos/{repo}/license')
    j = json.loads(body)
    return {'repo': repo, 'http_status': status, 'spdx_id': (j.get('license') or {}).get('spdx_id'), 'license_file': j.get('html_url')}

out = {'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sources': []}

# StatsBomb open data: licence is a PDF user agreement, not an SPDX licence.
status, pdf = get('https://raw.githubusercontent.com/statsbomb/open-data/master/LICENSE.pdf')
import pypdf
text = re.sub(r'\s+', ' ', ' '.join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages))
def clause(start, end):
    i = text.find(start); j = text.find(end, i + 1)
    return text[i:j].strip() if i >= 0 and j > i else None
out['sources'].append({
    'key': 'statsbomb_open', 'url': 'https://raw.githubusercontent.com/statsbomb/open-data/master/LICENSE.pdf', 'http_status': status,
    'sha256': hashlib.sha256(pdf).hexdigest(), 'bytes': len(pdf), 'extraction': 'pypdf text, whitespace collapsed',
    'clauses': {
        'purpose': clause('StatsBomb have made this data', 'The provision of Github'),
        '1.1': clause('1.1.', '1.2.'),
        '1.4': clause('1.4.', '2. Delivery'),
        '7': clause('7. Intellectual Property Rights', '8. General Terms'),
        'version': clause('StatsBomb Data: User Agreement', ' 5'),
    },
    'github': gh_license('statsbomb/open-data'),
})
for key, repo in [('openfootball', 'openfootball/football.json'), ('skillcorner_open', 'SkillCorner/opendata'), ('metrica_sample', 'metrica-sports/sample-data')]:
    try:
        out['sources'].append({'key': key, 'github': gh_license(repo)})
    except Exception as e:  # a repo without a licence file returns 404: record it
        out['sources'].append({'key': key, 'github': {'repo': repo, 'error': str(e)}})

d = pathlib.Path('docs/evidence/source-audit') / datetime.date.today().isoformat()
d.mkdir(parents=True, exist_ok=True)
(d / 'licenses.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
for s in out['sources']:
    print(s['key'], s.get('github', {}).get('spdx_id') or s.get('github', {}).get('error'))
