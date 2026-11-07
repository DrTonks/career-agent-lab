import {mkdirSync,writeFileSync} from 'node:fs';
const dir='evals/advice-repair-v17';mkdirSync(dir+'/data',{recursive:true});
const table=rows=>'|记录ID|类型|星期|开始|结束|\n|---|---|---|---|---|\n'+rows.map(r=>'|'+r.join('|')+'|').join('\n');
const specs=[{id:'service',title:'便民服务界面',hours:[7,7,4.5],h:4,cut:1,wedCut:4,a:{monthsAtLeast:3,daysAtLeast:2,everyWorkingDayHoursAtLeast:4}}, {id:'archive',title:'档案检索界面',hours:[6,6,6],h:5,cut:2,wedCut:2,a:{monthsAtLeast:3,daysAtLeast:2,weeklyHoursAtLeast:18}}, {id:'lab',title:'实验预约界面',hours:[5,5,3.5],h:3,cut:1,wedCut:3,a:{monthsAtLeast:3,daysAtLeast:3,qualifyingDays:{count:3,hoursAtLeast:3}}}, {id:'garden',title:'社区花园界面',hours:[7,7,0],h:4,cut:0,wedCut:4.5,a:{monthsAtLeast:3,daysAtLeast:2,weeklyHoursAtLeast:16}}];
const clock=h=>String(Math.floor(h)).padStart(2,'0')+':'+String(Math.round((h%1)*60)).padStart(2,'0');
const cases=specs.map(s=>{
 const id='v17-'+s.id,days=['周一','周三','周五'];
 const base=s.hours.flatMap((h,i)=>h?[[`base${i}`,'可用',days[i],'09:00',clock(9+h)]]:[]);
 const first=s.id==='garden'?[['extra','可用','周五','09:00','11:00']]:[['friClass','占用','周五',clock(9+s.hours[2]-s.cut),clock(9+s.hours[2])]];
 const texts=[`已确认连续实习月数为6。下表是已申报的每周出勤安排；有净可用时段的日计为申报出勤日。可用行取并集，扣占用行并集；新行追加，撤销行移除对应记录。其他岗位条件均已满足。\n${table(base)}`,`学校调整安排，追加下列记录，其他记录不变。\n${table(first)}`,`追加周三课程，其他不变。\n${table([['wedClass','占用','周三',clock(9+s.hours[1]-s.wedCut),clock(9+s.hours[1])]])}`,`周三课程取消，仅撤销该记录。\n${table([['wedClass','撤销','-','-','-']])}`];
 const jobs=[{id:id+'-a',title:s.title+'排班实习生',rule:s.a},{id:id+'-b',title:s.title+'组件实习生',rule:{monthsAtLeast:3,daysAtLeast:2,qualifyingDays:{count:2,hoursAtLeast:s.h}}}].map(j=>({...j,sourceId:'job:'+j.id,sourceType:'synthetic-public-rule-card',meaning:'以下JSON为岗位公开的全部时间条件；qualifyingDays是至少N天达标，everyWorkingDayHoursAtLeast是每个申报出勤日均达标；其余条件已确认满足。'}));
 const events=texts.map((text,i)=>({id:id+'-'+i,text,hypotheses:[{id:id+'-'+i+'-fri',description:'试演周五新增一小时占用；仅是假设，不修改实际日程。',text:table([['hypoFri','占用','周五',clock(9+(s.hours[2]||2)-1),clock(9+(s.hours[2]||2))]])},{id:id+'-'+i+'-wed',description:'试演周三全部时段被占用；仅是假设，不修改实际日程。',text:table([['hypoWed','占用','周三','00:00','24:00']])}]}));
 return {id,jobs,userFacts:{sourceId:'profile:'+id,months:6,text:'学校确认可连续实习6个月。'},historicalMemory:{id:'old:'+id,text:'历史报告曾写周工时=25；这是旧版本记录，不是当前事实。旧警示称“周五再减一小时，B岗就一定不符”，该警示待复核。'},events};
});
writeFileSync(dir+'/data/test.json',JSON.stringify(cases,null,2)+'\n');
