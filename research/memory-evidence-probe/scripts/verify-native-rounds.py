"""Verify published V16/V17 records offline; no API or credential access."""
import ast,hashlib,json,re
from pathlib import Path
REPO=Path(__file__).resolve().parents[3]
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
report={}
# V16 compact export retains artifacts and event receipts, without SQLite or streams.
b=REPO/'evals/advice-repair-v16/results/test-r2';manifest=read(b/'export-manifest.json')
for entry in manifest['files']:assert sha(b/entry['export'])==entry['exportSha256'],entry['export']
gold=read(REPO/'evals/advice-repair-v16/private/gold.json');summary=read(b/'summary.json')
counts={};starts=0
for arm in summary['totals']:
 counts[arm]={'events':0,'finalCorrect':0,'recommendationsCorrect':0,'unrelatedDispatches':0}
 for tid,events in gold.items():
  for i in range(1,4):
   p=b/'events'/tid/arm/f'event-{i}';out=read(p/'result.json');expected=events[i]['labels'];clean=out['answer'].replace('**','').replace('`','')
   correct=True
   for jid,val in expected.items():
    matches=re.findall(r'核定\s*[\[【]\s*(?:job:)?'+re.escape(jid)+r'\s*[\]】]\s*[=＝:：]\s*(符合|不符|待核定)',clean)
    matches+=re.findall(r'^\|\s*(?:job:)?'+re.escape(jid)+r'\s*\|\s*(符合|不符|待核定)\s*\|',clean,re.M)
    correct &= set(matches)=={val}
   arts={a['expert']:a for a in out['effectiveArtifacts']};m=arts['match'];rank=sorted(j['id'] for j in m['result']['artifact'].get('rankedJobs',[]))
   counts[arm]['events']+=1;counts[arm]['finalCorrect']+=correct;counts[arm]['recommendationsCorrect']+=rank==sorted(k for k,v in expected.items() if v=='符合')
   review=read(p/'review.json');counts[arm]['unrelatedDispatches']+=len(review.get('active',[])) if not events[i]['requiredUpdatedRoles'] else 0
   for ev in read(p/'runtime-events.json'):
    if ev['type']=='expert.started':
     assert ev['payload']['independentContext'] is True;assert ev['payload']['thread'].startswith(out['runId']+'::');starts+=1
 for key,value in counts[arm].items():assert summary['totals'][arm][key]==value,(arm,key)
report['v16']={'compactFilesVerified':len(manifest['files']),'businessCounts':counts,'independentExpertExecutions':starts,'scope':'Recomputed final labels/candidate sets and verified compact record hashes; stored full-raw audits retained separately.'}
# V17 independent minute-set oracle, loaded as pure functions, with no file writes.
b=REPO/'evals/advice-repair-v17/results/test-r1';base=b/'source-snapshot/evals/advice-repair-v17'
source=(base/'gold.py').read_text();tree=ast.parse(source);pure=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]);ns={'DAYS':['周一','周二','周三','周四','周五','周六','周日']};exec(compile(pure,'gold.py','exec'),ns)
reg=read(b/'registration.json')
for path,h in reg['hashes'].items():assert sha(b/'source-snapshot'/path)==h,path
original=read(b/'bundle-sha256.json');omitted=[]
for path,h in original.items():
 p=b/path
 if not p.exists():assert p.suffix=='.log',path;omitted.append(path);continue
 assert sha(p)==h,path
summary=read(b/'summary.json');policies=['text','structured','verified'];count={p:{'currentCommitted':0,'correctProposals':0,'falseAccepted':0,'acceptedCount':0,'fullyResolved':0} for p in policies};replay={p:{'falseAccepted':0,'correctAccepted':0,'unresolvedCount':0} for p in policies};authorCorrect=0;authorPredictions=0
for t in read(base/'data/test.json'):
 for i,e in enumerate(t['events']):
  texts=[x['text'] for x in t['events'][:i+1]];daily=ns['calendar'](texts);judgments={j['id']:ns['verdict'](j['rule'],daily,t['userFacts']['months']) for j in t['jobs']};g={}
  for h in e['hypotheses']:
   after=ns['calendar'](texts+[h['text']])
   for j in t['jobs']:
    val=ns['verdict'](j['rule'],after,t['userFacts']['months']);g[h['id'],j['id']]=(val,val!=judgments[j['id']])
  def good(c):return g[c['hypothesisId'],c['jobId']]==(c['predictedAfter'],c['claimsRefutation'])
  d=b/t['id']/f'event-{i}';a=read(d/'author/actor-result.json')['parsed'];authorCorrect+=a['currentAssessment']['weeklyHours']==sum(daily.values()) and all(judgments[j['jobId']]==j['verdict'] for j in a['currentAssessment']['judgments']);authorPredictions+=sum(good(c) for c in a['cases'])
  for p in policies:
   r=read(d/p/'result.json');o=r['outcome'];count[p]['currentCommitted']+=o['currentStateCommitted'];count[p]['fullyResolved']+=o['fullyResolved'];count[p]['correctProposals']+=sum(good(c) for c in r['review']['cases']);count[p]['acceptedCount']+=len(o['acceptedCases']);count[p]['falseAccepted']+=sum(not good(c) for c in o['acceptedCases'])
   allowed=[c for c in a['cases'] if p!='verified' or good(c)];replay[p]['correctAccepted']+=sum(good(c) for c in allowed);replay[p]['falseAccepted']+=sum(not good(c) for c in allowed);replay[p]['unresolvedCount']+=len(g)-len(allowed)
for p in policies:
 for k,v in count[p].items():assert summary['live'][p][k]==v,(p,k)
 for k,v in replay[p].items():assert summary['sharedAuthorReplay'][p][k]==v,(p,k)
assert authorCorrect==summary['authors']['currentCorrect'];assert authorPredictions==summary['authors']['correctProposals']
u={'calls':0,'input':0,'output':0,'cachedInput':0,'errors':0}
for path in b.glob('*/event-*/*/calls/*.json'):
 c=read(path);u['calls']+=1;u['errors']+=c['status']!='ok'
 for k in ['input','output','cachedInput']:u[k]+=c.get('response',{}).get('usage',{}).get(k,0) or 0
assert u==summary['usage']['total']
report['v17']={'frozenFilesVerified':len(reg['hashes']),'originalBundleFilesVerified':len(original)-len(omitted),'omittedLocalLogs':omitted,'authorCurrentCorrect':authorCorrect,'authorPredictionsCorrect':authorPredictions,'live':count,'sameAuthorReplay':replay,'usage':u}
report['passed']=True
out=Path(__file__).with_name('native-rounds-verification.json');out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
