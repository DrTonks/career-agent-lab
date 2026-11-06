// A2 copy of V6 accounting, with injected A2 prompt stages and DeepSeek gate.
import {DatabaseSync} from 'node:sqlite';
import {hash} from './core.mjs';
import {messages,parse as parseStage} from './prompts.mjs';

export class BudgetError extends Error {}
const validUsage=n=>Number.isSafeInteger(n)&&n>=0;
// Sender injection makes every offline check network-free. A separate ledger DB
// is required so event-state rollback never erases already billed calls.
export class MeteredClient {
  constructor({path,model,settings,limits,eventLimits,completionLimits,send}){
    if(model!=='deepseek')throw Error('Only DeepSeek is authorized');
    this.path=path;
    this.db=new DatabaseSync(path);this.model=model;this.settings=settings;
    // Monitoring readers must not interrupt reservations or paid-call writes.
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.limits=limits;this.eventLimits=eventLimits;this.completionLimits=completionLimits;this.send=send;this.busy=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,namespace TEXT,event_key TEXT,stage TEXT,state TEXT,messages TEXT,parameters TEXT,answer TEXT,usage TEXT,input_charge INTEGER,output_charge INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS uses(id INTEGER PRIMARY KEY,call_id TEXT,namespace TEXT,event_key TEXT,stage TEXT,reused INTEGER);
      CREATE TABLE IF NOT EXISTS parse_failures(call_id TEXT PRIMARY KEY,stage TEXT,kind TEXT);
      CREATE TABLE IF NOT EXISTS client_manifest(id INTEGER PRIMARY KEY,signature TEXT);`);
    const signature=hash({model,settings,limits,eventLimits,completionLimits});
    this.db.prepare('INSERT OR IGNORE INTO client_manifest VALUES(1,?)').run(signature);
    if(this.db.prepare('SELECT signature FROM client_manifest WHERE id=1').get().signature!==signature)throw Error('Ledger configuration changed');
  }
  close(){this.db.close();}
  usage(eventKey=null){
    const where=eventKey===null?'':' WHERE event_key=?';
    const args=eventKey===null?[]:[eventKey];
    return this.db.prepare(`SELECT count(*) attempts,coalesce(sum(input_charge),0) inputTokens,coalesce(sum(output_charge),0) outputTokens FROM calls${where}`).get(...args);
  }
  allocatedUsage(namespace){
    return this.db.prepare(`SELECT count(*) calls,coalesce(sum(c.input_charge),0) inputTokens,coalesce(sum(c.output_charge),0) outputTokens FROM calls c JOIN (SELECT DISTINCT call_id FROM uses WHERE namespace=?) u ON c.id=u.call_id`).get(namespace);
  }
  parse(id,stage,answer){
    try{return parseStage(stage,answer);}catch(error){this.db.prepare('INSERT OR IGNORE INTO parse_failures VALUES(?,?,?)').run(id,stage,error instanceof SyntaxError?'invalid-json':'invalid-schema');throw error;}
  }
  async call(namespace,eventKey,stage,payload){
    if(this.busy)throw Error('Concurrent use requires a separate sequential scheduler');
    this.busy=true;
    try{
      const msgs=messages(stage,payload),limit=this.completionLimits[stage];
      if(!Number.isSafeInteger(limit)||limit<=0)throw Error('Missing stage completion cap');
      const parameters={...this.settings,limit},id=hash({namespace,model:this.model,parameters,messages:msgs});
      const old=this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);
      if(old){
        if(old.state!=='ok')throw Error('Prior attempt failed or unresolved; automatic resampling blocked');
        this.db.prepare('INSERT INTO uses(call_id,namespace,event_key,stage,reused) VALUES(?,?,?,?,1)').run(id,namespace,eventKey,stage);
        return this.parse(id,stage,old.answer);
      }
      const input=Buffer.byteLength(JSON.stringify(msgs),'utf8')+msgs.length*64;
      for(const [used,cap]of [[this.usage(),this.limits],[this.usage(eventKey),this.eventLimits]]){
        if(used.attempts+1>cap.attempts||used.inputTokens+input>cap.inputTokens||used.outputTokens+limit>cap.outputTokens)throw new BudgetError('Budget reservation exceeds cap');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.prepare('INSERT INTO calls(id,namespace,event_key,stage,state,messages,parameters,input_charge,output_charge) VALUES(?,?,?,?,?,?,?,?,?)').run(id,namespace,eventKey,stage,'pending',JSON.stringify(msgs),JSON.stringify(parameters),input,limit);
        this.db.prepare('INSERT INTO uses(call_id,namespace,event_key,stage,reused) VALUES(?,?,?,?,0)').run(id,namespace,eventKey,stage);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      let reply;
      try{reply=await this.send({model:this.model,messages:msgs,limit,settings:this.settings});}
      catch(error){
        // Never persist provider error bodies or arbitrary injected exception text.
        this.db.prepare("UPDATE calls SET state='error',error=? WHERE id=?").run(error?.name==='AbortError'?'transport-aborted':'transport-failed',id);
        throw Error('Model transport failed; reservation retained');
      }
      const raw=reply.usage?.raw??{},chargedInput=validUsage(raw.prompt_tokens)?raw.prompt_tokens:input,chargedOutput=validUsage(raw.completion_tokens)?raw.completion_tokens:limit;
      this.db.prepare("UPDATE calls SET state='ok',answer=?,usage=?,input_charge=?,output_charge=? WHERE id=?").run(String(reply.answer??''),JSON.stringify(reply.usage??{}),chargedInput,chargedOutput,id);
      // Parsing happens after accounting. An invalid response is paid and preserved.
      return this.parse(id,stage,String(reply.answer??''));
    }finally{this.busy=false;}
  }
  adapter(namespace,eventKey){const fn=(stage,payload)=>this.call(namespace,eventKey,stage,payload);fn.ledgerDb=this.db;fn.ledgerPath=this.path;return fn;}
}
