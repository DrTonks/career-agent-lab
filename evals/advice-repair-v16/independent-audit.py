"""Recompute final business metrics and usage independently from raw records."""
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]);read=lambda p:json.loads(p.read_text());gold=read(root/'source-snapshot/evals/advice-repair-v16/private/gold.json');summary=read(root/'summary.json');errors=[]
def clean(text):return text.replace('**','').replace('`','')
def verdicts(text,ids):
    text=clean(text);out={}
    for jid in ids:
        values=re.findall(r'核定\s*[\[【]\s*(?:job:)?'+re.escape(jid)+r'\s*[\]】]\s*[=＝:：]\s*(符合|不符|待核定)',text)
        values+=re.findall(r'^\|\s*(?:job:)?'+re.escape(jid)+r'\s*\|\s*(符合|不符|待核定)\s*\|',text,re.M)
        out[jid]=values[0] if len(set(values))==1 else None
    return out
def hours(text):
    v=[float(x) for x in re.findall(r'周工时\s*[=＝:：]\s*([0-9]+(?:\.[0-9]+)?)',clean(text))]
    return v[0] if len(set(v))==1 else None
valid=lambda a:bool(a) and not a.get('failure') and a['result']['status'] in ['succeeded','partial'];counts={}
for arm in summary['totals']:
    count=dict.fromkeys(['primaryCorrect','verdictsCorrect','finalCorrect','recommendationsCorrect','freshnessCorrect','arithmeticCorrect','roleArithmeticCorrect'],0)
    for tid,events in gold.items():
        for i in range(1,4):
            d=read(root/tid/arm/f'event-{i}/result.json');g=events[i];expect=g['labels'];current={a['id'] for a in d['artifacts']};arts={a['expert']:a for a in d['effectiveArtifacts']}
            role_good={role:valid(arts.get(role)) and verdicts(arts[role]['result']['summary'],expect)==expect for role in ['match','path','report']}
            m=arts.get('match');rank=sorted(j['id'] for j in m['result']['artifact'].get('rankedJobs',[])) if m else []
            rows={'verdictsCorrect':all(role_good.values()),'finalCorrect':verdicts(d['answer'],expect)==expect,'recommendationsCorrect':valid(m) and rank==sorted(k for k,v in expect.items() if v=='符合'),'freshnessCorrect':all(role_good[r] and arts[r]['id'] in current for r in g['requiredUpdatedRoles']),'arithmeticCorrect':hours(d['answer'])==g['calculation'],'roleArithmeticCorrect':all(hours(arts.get(r,{}).get('result',{}).get('summary',''))==g['calculation'] for r in ['match','path','report'])}
            rows['primaryCorrect']=all(rows.values())
            for k,v in rows.items():count[k]+=int(v)
    counts[arm]=count
    for k,v in count.items():
        if v!=summary['totals'][arm][k]:errors.append(f'{arm}/{k}: {v} != summary')
usage=dict(calls=0,successfulCalls=0,failedCalls=0,pendingCalls=0,inputTokens=0,outputTokens=0,cachedInputTokens=0,reviewCalls=0)
for p in root.glob('*/*/*/calls/*.json'):
    x=read(p);usage['calls']+=1;usage['reviewCalls']+=int(x['phase']=='review');usage[{'ok':'successfulCalls','error':'failedCalls','pending':'pendingCalls'}[x['status']]]+=1
    if x['status']=='ok':
        for k,s in [('inputTokens','input'),('outputTokens','output'),('cachedInputTokens','cachedInput')]:usage[k]+=x['response']['usage'].get(s,0)
saved=read(root/'usage.json')['total']
for k,v in usage.items():
    if v!=saved[k]:errors.append('usage/'+k)
out={'passed':not errors,'businessCounts':counts,'usage':usage,'errors':errors};(root/'independent-validation.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out,ensure_ascii=False,indent=2));sys.exit(bool(errors))
