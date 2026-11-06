#!/usr/bin/env python3
"""Check the public bundle without printing matched secret text."""
import json
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
# Pattern pieces avoid self-matching while retaining plain reviewable checks.
checks={
 'local-home-path':re.compile(r'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
 'credential-looking-string':re.compile(r'\bsk-[A-Za-z0-9_-]{16,}\b|Bearer\s+[A-Za-z0-9._-]{16,}'),
 'private-key-block':re.compile('BEGIN '+r'(?:RSA |EC |OPENSSH )?PRIVATE KEY'),
 'local-username':re.compile('ton'+'ks',re.I),
 'email-address':re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
}
allowed_hosts={'api.deepseek.com','api.openai.com','github.com','www.w3.org','arxiv.org','doi.org','docs.letta.com','docs.mem0.ai','platform.claude.com'}
issues=[];files=0;byte_count=0;urls=set()
for p in ROOT.rglob('*'):
 if not p.is_file() or any(x in p.parts for x in ('node_modules','__pycache__','.git','live-runs')):continue
 rel=str(p.relative_to(ROOT))
 if rel=='scripts/privacy-report.json':continue
 if p.suffix in ('.sqlite','.db') or '.sqlite-' in p.name or p.name in ('.env','api.txt','openai.txt'):
  issues.append({'file':rel,'rule':'forbidden-artifact'})
 if p.suffix not in ('.json','.jsonl','.mjs','.py','.md','.txt','.svg','.html') and p.name not in ('package.json','.gitignore'):continue
 text=p.read_text();files+=1;byte_count+=p.stat().st_size
 scan_text=text.replace('https://github.com/Dr'+'Ton'+'ks/career-agent-lab','https://github.com/PUBLIC_OWNER/career-agent-lab')
 for label,pattern in checks.items():
  if pattern.search(scan_text):issues.append({'file':rel,'rule':label})
 for m in re.finditer(r'https?://([^/\s\"\'<>\\)]+)',text):
  host=m[1].split(':')[0].lower();urls.add(host)
  if host not in allowed_hosts:issues.append({'file':rel,'rule':'unapproved-url-host'})
report={'passed':not issues,'filesScanned':files,'bytesScanned':byte_count,'urlHosts':sorted(urls),'issues':issues,'notes':['Matches report only filename and rule, never matching secret content.','No original SQLite, credential file, local-home path, local username or credential-looking token permitted.','Synthetic participant/job identifiers and source prose are intentionally retained.','This is a pattern-based release check, not proof that every possible identifier is absent.']}
(ROOT/'scripts/privacy-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if report['passed'] else 1)
