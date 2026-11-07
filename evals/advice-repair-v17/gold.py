"""Independent minute-set oracle; never imported by model-facing tools."""
import json
from pathlib import Path
BASE=Path(__file__).parent
DAYS=['周一','周二','周三','周四','周五','周六','周日']
def calendar(texts):
    active={}
    for text in texts:
        for line in text.splitlines():
            parts=[p.strip() for p in line.split('|')[1:-1]]
            if len(parts)!=5 or parts[1] not in ['可用','占用','撤销']: continue
            rid,kind,day,start,end=parts
            if kind=='撤销': del active[rid]; continue
            def minute(x):
                h,m=map(int,x.split(':'));return h*60+m
            active[rid]=(kind,day,set(range(minute(start),minute(end))))
    result={}
    for day in DAYS:
        free=set();busy=set()
        for kind,d,minutes in active.values():
            if d==day: (free if kind=='可用' else busy).update(minutes)
        result[day]=len(free-busy)/60
    return result

def verdict(rule,daily,months):
    positive=[v for v in daily.values() if v>0]
    checks=[months>=rule['monthsAtLeast'],len(positive)>=rule['daysAtLeast']]
    if 'weeklyHoursAtLeast' in rule: checks.append(sum(positive)>=rule['weeklyHoursAtLeast'])
    if 'qualifyingDays' in rule:
        q=rule['qualifyingDays'];checks.append(sum(v>=q['hoursAtLeast'] for v in positive)>=q['count'])
    if 'everyWorkingDayHoursAtLeast' in rule: checks.append(all(v>=rule['everyWorkingDayHoursAtLeast'] for v in positive))
    return '符合' if all(checks) else '不符'

out=[]
for t in json.loads((BASE/'data/test.json').read_text()):
    for i,e in enumerate(t['events']):
        texts=[e['text'] for e in t['events'][:i+1]];daily=calendar(texts)
        judgments={j['id']:verdict(j['rule'],daily,t['userFacts']['months']) for j in t['jobs']}
        cases=[]
        for h in e['hypotheses']:
            after=calendar(texts+[h['text']])
            for j in t['jobs']:
                prediction=verdict(j['rule'],after,t['userFacts']['months'])
                cases.append(dict(hypothesisId=h['id'],jobId=j['id'],predictedAfter=prediction,claimsRefutation=prediction!=judgments[j['id']]))
        out.append(dict(trajectory=t['id'],event=i,dailyHours=daily,weeklyHours=sum(daily.values()),judgments=judgments,cases=cases))
(BASE/'private').mkdir(exist_ok=True)
(BASE/'private/gold.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
