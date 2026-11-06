#!/usr/bin/env python3
"""Offline recomputation from published records. Never imports a model client."""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return json.loads(path.read_text())
def lines(path):
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()]
def check(ok, message):
    if not ok:
        raise AssertionError(message)
def equal(a,b):
    return json.dumps(a,sort_keys=True,separators=(',',':')) == json.dumps(b,sort_keys=True,separators=(',',':'))

def cross_model():
    base=ROOT/'experiments/01-cross-model'
    rows=lines(base/'decisions.jsonl'); summary=read(base/'summary.json')
    gold={g['id']:g for g in lines(base/'gold.jsonl')}
    check(len(rows)==432,'Round 01 must retain 432 formal holdout decisions')
    check(len({(r['model'],r['id']) for r in rows})==432,'Round 01 duplicate predictions')
    result={}
    for judge in ('deepseek','gpt'):
        result[judge]={}
        for model in ('deepseek','gpt'):
            result[judge][model]={}
            for arm in ('O','B','L','N'):
                selected=[r for r in rows if r['model']==model and r['arm']==arm]
                check(len(selected)==54,'Round 01 cell denominator')
                count=0
                for r in selected:
                    p=r['prediction'];g=gold[r['expected']['id']];flags=r['review'][judge]
                    check(equal(g,r['expected']),'Round 01 embedded gold mismatch')
                    structure=bool(p and p['fit']==g['fit'] and p['action']==g['action'] and (g['anchor'] is None or p['target']==g['anchor']))
                    strict=structure and all(flags[k] for k in ('meaningOK','evidenceOK','unrelatedPreserved')) and not any(flags[k] for k in ('hypothesisLeak','unneededInterruption'))
                    check(strict==r['strict'][judge] and structure==r['structure'],'Round 01 score differs')
                    count+=strict
                expected=summary['judges'][judge]['aggregate'][model][arm]
                check(count==expected['strict'] and len(selected)==expected['n'],'Round 01 aggregate differs')
                result[judge][model][arm]={'correct':count,'total':len(selected)}
    return {'judges':result,'note':'Stored model-judge flags are preserved, not independently re-judged offline. Both judges retained.'}

def commit_consistency():
    base=ROOT/'experiments/02-commit-consistency'
    cases=read(base/'data/cases.json'); gold={g['id']:g for g in read(base/'gold.json')}
    saved={(r['caseId'],r['arm']):r for r in read(base/'scored-cases.json')}
    summary=read(base/'summary.json');counts={}
    check(len(cases)==96 and len(saved)==288,'Round 02 coverage')
    for c in cases:
        g=gold[c['id']];result=read(base/'cases'/c['id']/'result.json')
        for arm,r in result['records'].items():
            target=next((m for m in r.get('finalMemories',[]) if m['id']==c['targetId']),None)
            collateral=any(not equal(next((n for n in r.get('finalMemories',[]) if n['id']==m['id']),None),m) for m in c['memories'] if m['id']!=c['targetId'])
            correct=r['status']=='ok' and target is not None and equal(target['values'],g['values']) and target['status']==g['status'] and not collateral
            check(correct==saved[c['id'],arm]['correct'],'Round 02 score differs')
            k=(g['split'],arm);counts.setdefault(k,Counter()).update(total=1,correct=int(correct))
    out={}
    for (split,arm),count in counts.items():
        check(all(count[k]==summary['splits'][split]['arms'][arm][k] for k in ('total','correct')),'Round 02 aggregate differs')
        out.setdefault(split,{})[arm]=dict(count)
    return out

def active_evidence():
    base=ROOT/'experiments/03-active-evidence'
    spec=importlib.util.spec_from_file_location('support',ROOT/'runtime/support.py')
    support=importlib.util.module_from_spec(spec);spec.loader.exec_module(support)
    trajectories=read(base/'data/trajectories.json');gold={g['id']:g for g in read(base/'gold.json')}
    saved={(x['trajectory'],x['eventId'],x['arm']):x for x in read(base/'scored-events.json')}
    summary=read(base/'summary.json');supp=read(base/'evidence-support-audit.json')
    result={};witnesses=missed=0;computed={}
    check(len(trajectories)==12 and len(saved)==216,'Round 03 coverage')
    for arm in ('ordinary','extra-review','probe'):
        counts=Counter(events=0,correct=0,evidenceSupported=0)
        for t in trajectories:
            previous=read(base/'trajectories'/t['id']/'initialization.json')['state']
            records=read(base/'trajectories'/t['id']/(arm+'.json'))['records']
            check(len(records)==6,'Round 03 incomplete trajectory')
            for event,label,rec in zip(t['events'],gold[t['id']]['steps'],records):
                check(rec['eventId']==label['eventId']==event['id'],'Round 03 pairing')
                assessed=support.assess(rec,label,previous,event)
                key=(t['id'],event['id'],arm);computed[key]=assessed['primaryCorrectRecomputed']
                check(assessed['primaryCorrectRecomputed']==saved[key]['correct'],'Round 03 score differs')
                counts.update(events=1,correct=int(assessed['primaryCorrectRecomputed']),evidenceSupported=int(assessed['evidenceSupportedFullState']))
                ca=assessed['counterexampleAudit']
                if ca:
                    witnesses+=len(ca['witnesses']);missed+=len(ca['missedCounterexampleRoles'])
                    check(all(w['genuineCounterexample'] for w in ca['witnesses']),'Round 03 semantic witness mismatch')
                previous=rec['state']
        check(counts['correct']==summary['arms'][arm]['correct'],'Round 03 accuracy differs')
        check(counts['evidenceSupported']==supp['arms'][arm]['evidenceSupportedFullState'],'Round 03 support differs')
        result[arm]=dict(counts)
    pairs=Counter(wins=0,losses=0,ties=0)
    for t in trajectories:
        for event in t['events']:
            p=computed[t['id'],event['id'],'probe'];e=computed[t['id'],event['id'],'extra-review']
            pairs['wins' if p and not e else 'losses' if e and not p else 'ties']+=1
    check(dict(pairs)==summary['pairs']['extra-review -> probe'],'Round 03 paired result differs')
    check(witnesses==46 and missed==10,'Round 03 witness coverage differs')
    return {'arms':result,'probeVsExtraReview':dict(pairs),'genuineWitnesses':witnesses,'missedTargetOpportunities':missed,'note':'Support recomputed with extracted frozen audit functions; nonblind prose audits remain separate records.'}

def usage():
    out={}
    for name in ('02-commit-consistency','03-active-evidence'):
        base=ROOT/'experiments'/name;calls=lines(base/'calls.jsonl');summary=read(base/'summary.json')
        prompt=sum(c['usage']['raw']['prompt_tokens'] for c in calls)
        completion=sum(c['usage']['raw']['completion_tokens'] for c in calls)
        check(len(calls)==summary['physicalUsage']['attempts'],'Formal call count mismatch')
        check(prompt==summary['physicalUsage']['inputTokens'] and completion==summary['physicalUsage']['outputTokens'],'Formal token accounting mismatch')
        out[name]={'physicalCalls':len(calls),'inputTokens':prompt,'outputTokens':completion}
    return out

def manifest(write=False):
    path=ROOT/'experiments/checksums.json'
    files=[p for p in ROOT.rglob('*') if p.is_file() and not any(x in p.parts for x in ('__pycache__','node_modules','.git','live-runs'))]
    excluded={'experiments/checksums.json','scripts/privacy-report.json','scripts/verification-report.json'}
    hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files) if str(p.relative_to(ROOT)) not in excluded}
    if write:path.write_text(json.dumps({'sha256':hashes,'scope':'Public release source, data, docs and figures; generated validation reports and this manifest are excluded.'},indent=2)+'\n')
    else:
        expected=read(path)['sha256'];check(hashes==expected,'Public file manifest differs; review before regenerating')
    return len(hashes)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write-manifest',action='store_true');args=parser.parse_args()
    result={'offline':True,'externalAPICalls':0,'round01':cross_model(),'round02':commit_consistency(),'round03':active_evidence(),'formalUsage':usage(),'verifiedPublicFiles':manifest(args.write_manifest)}
    (ROOT/'scripts/verification-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
