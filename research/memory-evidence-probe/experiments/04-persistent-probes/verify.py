"""Independent Python replay of source authority, arithmetic and paid-call accounting.
No model calls, no changes to registered runtime/data or outputs.
"""
from pathlib import Path
import json, itertools, sqlite3, sys, hashlib
root=Path(sys.argv[1]); reg=json.loads((root/'registration.json').read_text())
snapshot=root/'source'
data={t['id']:t for t in json.loads((snapshot/f"data/{reg['split']}.json").read_text())}
gold=json.loads((snapshot/'private/gold.json').read_text())
arms=reg['arms']; issues=[]; counts={a:{'events':0,'correct':0,'supportedCorrect':0,'roleCorrect':0} for a in arms}
calls={'attempts':0,'ok':0,'pending':0,'error':0,'inputTokens':0,'outputTokens':0}; latencies=[]

def derive(x,r):
    month=x['months']>=r['minMonths']; day=x['days']>=r['minDays']; week=x['days']*x['hours']>=r['minWeekly']
    tests={
      'standard':month and day and week,
      'portfolio':(month or x['certified']) and day and week,
      'combined':month and x['days']+x['remote']>=r['minDays'] and week,
      'extension':x['months']+x['extension']>=r['minMonths'] and day and week,
      'either':month and (day or week),
      'floor':month and day and x['hours']>=r['minDaily']}
    e=bool(x['permitted'] and tests[r['family']])
    return {'match':e,'report':e,'path':('wait' if x['applied'] else 'apply') if e else ('withdraw' if x['applied'] else 'none')}

def consensus(facts,domains,r):
    keys=list(facts); vals=[domains[k] if facts[k]['value'] is None else [facts[k]['value']] for k in keys]
    all_values=[derive(dict(zip(keys,v)),r) for v in itertools.product(*vals)]
    return {k:all_values[0][k] if all(v[k]==all_values[0][k] for v in all_values) else None for k in ['match','path','report']}

def observed(facts,observations,source_id,document=False):
    for k,v in observations.items():
        if document and v['version']!=facts[k]['version']:continue
        if not document and v['version']<facts[k]['version']:continue
        if document and facts[k]['value'] is not None and facts[k]['value']!=v['value']:raise AssertionError('conflicting current document')
        facts[k]={**v,'sourceId':source_id}

for repeat in range(1,reg['repeats']+1):
 for tid in reg['ids']:
  t=data[tid];g=gold[tid];folder=root/f'repeat-{repeat}'/tid
  for name in ['initialization',*arms]:
   ledger=folder/(name+'.calls.jsonl')
   rows=[json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
   groups={}
   for row in rows:
    state=row['state'];i=row['input_charge'];o=row['output_charge'];u=row['usage']
    calls['attempts']+=1;calls[state]+=1;calls['inputTokens']+=i;calls['outputTokens']+=o
    if u:
     raw=u.get('raw',{})
     if 'prompt_tokens' in raw and raw['prompt_tokens']!=i:issues.append(['input-accounting',tid,name])
     if 'completion_tokens' in raw and raw['completion_tokens']!=o:issues.append(['output-accounting',tid,name])
     latencies.append(u.get('latencyMs',0))
    g0=groups.setdefault(row['event_key'],[0,0,0]);g0[0]+=1;g0[1]+=i;g0[2]+=o
   for ek,(n,i,o) in groups.items():
    if n>reg['perEvent']['attempts'] or i>reg['perEvent']['inputTokens'] or o>reg['perEvent']['outputTokens']:issues.append(['event-cap',tid,name,ek])

  for arm in arms:
   f=folder/(arm+'.json')
   if not f.exists():continue
   records=json.loads(f.read_text())['records'];facts={k:{'value':v,'version':1,'sourceId':'initial-'+tid} for k,v in t['initial'].items()};oracle=json.loads(json.dumps(facts));rule=t['rule'];docs={};n=0
   for rec in records:
    if rec.get('initial'):continue
    e=t['events'][n];n+=1
    if e['scope']==t['scope']:
     observed(facts,e.get('observations',{}),e['id']);observed(oracle,e.get('observations',{}),e['id'])
     if 'rule' in e:rule=e['rule']
    for d in e.get('documents',[]):docs[d['id']]=d
    for did in rec['reads']:
     if did not in docs:issues.append(['unavailable-read',tid,arm,n]);continue
     d=docs[did]
     if d['scope']==t['scope']:observed(facts,d['observations'],did,True)
    for d in docs.values():
     if d['scope']==t['scope']:observed(oracle,d['observations'],d['id'],True)
    if len(rec['reads'])>1:issues.append(['read-cap',tid,arm,n])
    if rec['state']['facts']!=facts:issues.append(['fact-replay-mismatch',tid,arm,n])
    if rec['state']['rule']!=rule:issues.append(['rule-replay-mismatch',tid,arm,n])
    expected=consensus(oracle,t['domains'],g['ruleSpecs'][rule['id']]);support=consensus(facts,t['domains'],g['ruleSpecs'][rule['id']]);values={k:rec['state']['memories'][k]['value'] for k in expected}
    correct=values==expected;supported=correct and values==support
    a=counts[arm];a['events']+=1;a['correct']+=correct;a['supportedCorrect']+=supported;a['roleCorrect']+=sum(values[k]==expected[k] for k in expected)
summary_path=root/'summary.json'
if summary_path.exists():
 s=json.loads(summary_path.read_text())
 for arm in arms:
  for k,v in counts[arm].items():
   if s['totals'][arm][k]!=v:issues.append(['score-disagreement',arm,k,v,s['totals'][arm][k]])
 for k in ['inputTokens','outputTokens']:
  if calls[k]!=s['physical'][k]:issues.append(['usage-disagreement',k])
if (root/'complete.json').exists():
 for arm in arms:
  if counts[arm]['events']!=len(reg['ids'])*reg['repeats']*8:issues.append(['missing-events',arm])
result={'independentLanguage':'Python','auditSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'counts':counts,'physical':calls,'meanLatencySeconds':sum(latencies)/len(latencies)/1000 if latencies else None,'issues':issues,'passed':not issues}
(root/'public-replay-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
if issues:sys.exit(1)
