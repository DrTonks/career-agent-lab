"""Export synthetic audit records; retain full streams/requests only under local var/."""
import json,sys,hashlib,shutil
from pathlib import Path
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
entries=[]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def export(src,dst,kind='copy'):
    dst.parent.mkdir(parents=True,exist_ok=True)
    if kind=='copy':shutil.copy2(src,dst)
    else:
        data=json.loads(src.read_text())
        if kind=='events-without-stream-deltas':data=[e for e in data if e['type'] not in ['model.stream','answer.delta']]
        if kind=='model-call-receipts':
            keys=['id','requestIdentity','executionStateHash','requestKey','scope','role','attempt','mode','model','inputEstimate','outputReserved','promptHash','toolNames','outputLimit','status','createdAt','usage','firstTokenMs','durationMs','finishReason','response','streamFrames','error']
            data=[{k:x[k] for k in keys if k in x} for x in data]
        dst.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    entries.append({'source':str(src.relative_to(root)),'export':str(dst.relative_to(out)),'policy':kind,'sourceSha256':digest(src),'exportSha256':digest(dst)})
for name in ['registration.json','complete.json','execution-status.json','summary.json','scored-events.json','usage.json','validation.json','independent-validation.json','content-review-excerpts.json','content-review.json','session-usage.json']:
    if (root/name).exists():export(root/name,out/name)
registration=json.loads((root/'registration.json').read_text())
trajectories=[p.name for p in root.iterdir() if p.is_dir() and (p/'shared').exists()]
for tid in trajectories:
    for arm in ['shared',*registration['arms']]:
        src=root/tid/arm;dst=out/'events'/tid/arm
        for name in ['fork.json','checkpoint.json','initialization/review.json']:
            if (src/name).exists():export(src/name,dst/name)
        for event in src.glob('event-*'):
            for name in ['result.json','review.json','context.json','runtime-events.json','model-calls.json']:
                if not (event/name).exists():continue
                kind={'runtime-events.json':'events-without-stream-deltas','model-calls.json':'model-call-receipts'}.get(name,'copy')
                export(event/name,dst/event.name/name,kind)
(out/'export-manifest.json').write_text(json.dumps({'fullRawPreserved':True,'excludedFromCompact':'Token streaming deltas and repeated full model input/tool schemas. Native artifacts, business tool receipts, responses and usage remain.','files':entries},ensure_ascii=False,indent=2)+'\n')
print('exported',len(entries),'files;',sum(p.stat().st_size for p in out.rglob('*') if p.is_file()),'bytes')
