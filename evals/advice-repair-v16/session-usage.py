"""Count actual API requests across pilot + final, excluding duplicated imported histories."""
import json,sys
from pathlib import Path
pilot,final=map(Path,sys.argv[1:3]);read=lambda p:json.loads(p.read_text())
keys=['calls','successfulCalls','failedCalls','pendingCalls','inputTokens','outputTokens','cachedInputTokens'];groups={k:dict.fromkeys(keys,0) for k in ['sharedPrefixActual','pilotAdditional','formalAdditional']}
for root in [pilot,final]:
 for p in root.glob('*/*/*/calls/*.json'):
  relative=p.relative_to(root);shared=relative.parts[1]=='shared'
  if root==final and shared:continue
  g=groups['sharedPrefixActual' if shared else 'pilotAdditional' if root==pilot else 'formalAdditional'];x=read(p);g['calls']+=1;g[{'ok':'successfulCalls','error':'failedCalls','pending':'pendingCalls'}[x['status']]]+=1
  if x['status']=='ok':
   for k,s in [('inputTokens','input'),('outputTokens','output'),('cachedInputTokens','cachedInput')]:g[k]+=x['response']['usage'].get(s,0)
out={'model':'deepseek-flash','counting':'Actual calls once; final imported shared-prefix log copies excluded. Cache tokens are included in input tokens.','groups':groups,'total':{k:sum(g[k] for g in groups.values()) for k in keys}}
(final/'session-usage.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
