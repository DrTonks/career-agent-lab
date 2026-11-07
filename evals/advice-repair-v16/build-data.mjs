import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {hash} from '../../dist/src/config.js';
const base=JSON.parse(readFileSync('data/synthetic/dataset.json'));
const cats=base.categories.filter(c=>c.family==='frontend'),edges=base.edges.filter(e=>cats.some(c=>c.id===e.source)&&cats.some(c=>c.id===e.target));
const cases=[],gold={};
const table=rows=>'\n日程原始记录：\n|记录ID|类型|星期|开始|结束|\n|---|---|---|---|---|\n'+rows.map(r=>'|'+r.join('|')+'|').join('\n');
for(const mode of ['gap','overlap']){
 const id='v16-'+mode,a=id+'-a',b=id+'-b';
 const job=(jid,title,req)=>({...base.jobs[0],id:jid,title,company:'合成校园界面组',source:'synthetic-integration',updatedAt:'2026-11-07',skills:['Vue','TypeScript','Git'],jd:`合成岗位：${title}。成都，本科应届，Vue、TypeScript、Git，月薪6000元。${req}累计时间按每周日程原表核算，占用时段不计入，重叠可用时段只计一次。具体星期和时段不作额外限制。不设其他门槛，其余条件已确认满足。本数据仅用于模拟核定。`});
 const jobs=[job(a,mode==='gap'?'校园空间预约界面实习生':'校园物资流转界面实习生','连续至少3个月，每周至少3天、累计至少21小时。'),job(b,'学生服务组件维护实习生','连续至少3个月，每周至少2天，至少两天各达到4小时。')];
 const dataset={version:hash(jobs),label:'Synthetic v16 '+mode,source:'synthetic',categories:cats,edges,documents:[],jobs};
 const resume='本科应届，在成都使用Vue、TypeScript、Git完成过网页组件项目，其他指定岗位条件已确认满足。';
 const initialRows=['周一','周三','周五'].flatMap((day,i)=>[[`base${i}`,'可用',day,mode==='gap'?'10:00':'09:00',mode==='gap'?'18:00':'17:00'],[`lunch${i}`,'占用',day,mode==='gap'?'13:00':'12:00',mode==='gap'?'14:00':'13:00']]);
 const instructions=`仅核定${a}和${b}的实习时间条件，给出模拟候选与行动。只有符合的纳入候选，不符或待核定的移出。首次四个专家协作，后续按最小必要范围更新。每个实际执行的专家summary和最终答复均写“周工时=数字”（当前每周有效小时数）；匹配、路径、报告summary与最终答复还需“核定[岗位ID]=符合/不符/待核定”。可沿用未变历史部分，但要检查其是否被新事实取代。路径使用已有前端类别关系，不增加原文之外的岗位门槛。`;
 const rule='我能连续实习6个月。以下是完整的每周重复日程原表，适用于整个实习期间：可用行取并集，再扣除占用行的并集；没有列为可用的时段不可实习。新行追加到原表；只有明确的撤销行才删除对应记录。原表之外没有其他日程限制。';
 const delta=mode==='gap'?[['course1','占用','周三','15:00','18:00']]:[['course1','占用','周五','12:30','15:30']];
 const addition=mode==='gap'?[['extra1','可用','周五','18:00','21:00']]:[['extra1','可用','周五','16:00','19:00']];
 const texts=[instructions+'\n'+rule+table(initialRows),'学校追加了下列每周课程安排，请据此更新原表和核定；其余记录不变。'+table(delta)+'\n请保留周工时与核定格式，只运行必要专家。','作品封面改为绿色，其他信息及日程原表不变。请沿用当前核定，保留周工时和核定格式，只运行必要专家。','学校新批准了下列可实习时段，请追加到原表；原有可用时段、课程和午休仍保留。'+table(addition)+'\n请更新核定，保留周工时和核定格式，只运行必要专家。'];
 const events=texts.map((text,i)=>({id:id+'-'+i,text})),hours=mode==='gap'?[21,18,18,21]:[21,18.5,18.5,20.5];
 gold[id]=events.map((_,i)=>({labels:{[a]:hours[i]>=21?'符合':'不符',[b]:'符合'},eventType:i===0?'prefix':i===2?'irrelevant':'implicit-change',requiredUpdatedRoles:i===1||i===3?['match','path','report']:[],calculation:hours[i]}));
 cases.push({id,split:'test',jobIds:[a,b],resume,constraints:{cities:['成都'],education:'本科',experienceYears:0,skills:['Vue','TypeScript','Git'],pathMode:'balanced'},events,snapshots:events.map(()=>dataset)});
}
for(const d of ['data','private'])mkdirSync('evals/advice-repair-v16/'+d,{recursive:true});
writeFileSync('evals/advice-repair-v16/data/test.json',JSON.stringify(cases,null,2)+'\n');writeFileSync('evals/advice-repair-v16/private/gold.json',JSON.stringify(gold,null,2)+'\n');
