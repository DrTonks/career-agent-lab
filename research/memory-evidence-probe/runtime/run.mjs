// Public portability: file layout and environment-only credentials; experiment algorithm unchanged.
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MeteredClient} from './client.mjs';
import {initialize,step} from './engine.mjs';
import {settings,deepseekSender} from './transport.mjs';
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const base=join(packageRoot,'experiments/03-active-evidence'),digest=f=>createHash('sha256').update(readFileSync(join(packageRoot,f))).digest('hex');
const write=(f,x)=>{mkdirSync(dirname(f),{recursive:true});writeFileSync(f+'.tmp',JSON.stringify(x,null,2)+'\n');renameSync(f+'.tmp',f);};
const [action,arg]=process.argv.slice(2),root=resolve(arg??'');
if(!arg||!['--register','--live'].includes(action))throw Error('Specify --register or --live and fresh root');
if(action==='--register'){
 if(existsSync(root))throw Error('Fresh root required');
 const files=[...readdirSync(join(packageRoot,'runtime')).filter(f=>/\.(mjs|py|json)$/.test(f)).map(f=>'runtime/'+f),'experiments/03-active-evidence/protocol.json','experiments/03-active-evidence/data/trajectories.json','experiments/03-active-evidence/gold.json','package.json'];
 const sha256={};for(const f of files){sha256[f]=digest(f);const dest=join(root,'source-snapshot',f);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(packageRoot,f),dest);}
 write(join(root,'registration.json'),{at:new Date().toISOString(),status:'frozen',protocol:JSON.parse(readFileSync(base+'/protocol.json')),sha256});console.log(JSON.stringify({registered:root,files:files.length}));
}else{
 const reg=JSON.parse(readFileSync(join(root,'registration.json'))),p=reg.protocol;
 if(reg.status!=='frozen'||p.provider!=='deepseek'||existsSync(join(root,'started.json')))throw Error('Invalid/started run');
 for(const [f,h]of Object.entries(reg.sha256))if(digest(f)!==h)throw Error('Frozen file changed: '+f);
 const trajectories=JSON.parse(readFileSync(base+'/data/trajectories.json'));if(trajectories.length!==12||trajectories.some(t=>t.events.length!==6))throw Error('Data shape');
 const key=process.env.DEEPSEEK_API_KEY?.trim();if(!key)throw Error('Set DEEPSEEK_API_KEY to run the explicitly requested live experiment');
 const send=deepseekSender(key);write(join(root,'started.json'),{at:new Date().toISOString(),gptEnabled:false});
 let cursor=0,finished=0;
 await Promise.all(Array.from({length:4},async()=>{while(cursor<trajectories.length){
  const index=cursor++,t=trajectories[index],dir=join(root,t.id);mkdirSync(dir,{recursive:true});
  const make=(name)=>new MeteredClient({path:join(dir,name+'.sqlite'),model:'deepseek',settings,limits:{attempts:40,inputTokens:3000000,outputTokens:122880},eventLimits:{attempts:5,inputTokens:500000,outputTokens:15360},completionLimits:Object.fromEntries(['decide','plan','ordinary','probe'].map(s=>[s,3072])),send});
  const init=make('initialization');let start;try{start=await initialize(t,(stage,payload)=>init.call(t.id+'/init',t.id+'/init',stage,payload));write(join(dir,'initialization.json'),start);}finally{init.close();}
  const arms=[...p.arms.slice(index%3),...p.arms.slice(0,index%3)];
  for(const arm of arms){let state=structuredClone(start.state);const client=make(arm),records=[],statePath=join(dir,arm+'-state.json');write(statePath,state);
   try{for(const [i,event]of t.events.entries()){
    if(i===3)state=JSON.parse(readFileSync(statePath));
    const record=await step(state,event,arm,(stage,payload)=>client.call(t.id+'/'+arm,t.id+'/'+event.id,stage,payload));state=record.state;records.push({...record,restarted:i===3});write(statePath,state);write(join(dir,arm+'.json'),{trajectoryId:t.id,arm,records});
    console.log(JSON.stringify({trajectory:t.id,arm,event:i+1,calls:record.calls,reads:record.reads.length,skipped:record.skipped,errors:record.errors.length,extraError:!!record.extraError}));
   }}finally{client.close();}
  }
  finished++;console.log(JSON.stringify({finished,total:trajectories.length}));
 }}));
 write(join(root,'complete.json'),{at:new Date().toISOString(),trajectories:finished,events:finished*6*3,gptCalls:0});
}
