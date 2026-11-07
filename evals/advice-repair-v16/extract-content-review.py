"""Post-run reading aid, no automatic replacement of the frozen metric."""
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]);gold=json.loads((root/'source-snapshot/evals/advice-repair-v16/private/gold.json').read_text());records=[]
for tid,events in gold.items():
 for arm in ['direct','natural','counterexample']:
  for i in range(1,4):
   p=root/tid/arm/f'event-{i}/result.json'
   if not p.exists():continue
   d=json.loads(p.read_text());texts={'answer':d['answer'],**{a['expert']:a['result']['summary'] for a in d.get('effectiveArtifacts',d['artifacts'])}}
   out={}
   for role,text in texts.items():
    cleaned=text.replace('**','').replace('`','');matches=list(re.finditer(r'周工时\s*[=＝:：]\s*([0-9]+(?:\.[0-9]+)?)',cleaned))
    out[role]={'opening':cleaned[:220],'hoursExpressions':[cleaned[max(0,m.start()-45):min(len(cleaned),m.end()+70)] for m in matches],'verdictExpressions':re.findall(r'核定\s*[\[【][^\]】]+[\]】]\s*[=＝:：]\s*(?:符合|不符|待核定)',cleaned),'rawResultFile':str(p.relative_to(root))}
   records.append({'trajectory':tid,'arm':arm,'event':i,'gold':events[i],'texts':out})
(root/'content-review-excerpts.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n');print('Saved reading excerpts for',len(records),'events; no scores changed.')
