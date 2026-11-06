import { z } from "zod";
import { compactMessages } from "../../dist/src/runtime.js";
import { estimateTokens } from "../../dist/src/config.js";

export const budgets = { wide: 16000, tight: 1750 };
export const arms = ["A", "B", "C"];
export const probePrompt = `你在建议刚交付时工作。你只知道当前来源和原句。为指定句提出一次未来复核：哪类变化值得重看？哪些真实行动或回执能够区分“仍需处理”和“已处理”？请考虑一个可能保留建议的例外。只生成查询问题或条件，避免假设已发生，不要输出未来给学生的答案。若没有有意义的检查，返回 {"probe":null}。否则返回 {"probe":{"anchor":"原句ID","premiseRefs":["来源ID"],"trigger":"条件","lookFor":["证据问题"],"exceptionQuestion":"应查的例外"}}。每个字段用简短中文。仅输出JSON。`;
export const probeSchema = z.object({ probe: z.object({
  anchor: z.string(), premiseRefs: z.array(z.enum(["jd","u0"])).min(1).max(2),
  trigger: z.string().trim().min(1).max(90),
  lookFor: z.array(z.string().trim().min(1).max(70)).min(1).max(3),
  exceptionQuestion: z.string().trim().min(1).max(90)
}).strict().nullable() }).strict();

const refs = z.array(z.string()).min(1).max(12);
export const matchSchema = z.object({
  fit: z.enum(["fits","conflict","exception","uncertain"]), reason: z.string().min(1).max(650), refs
}).strict();
export const reportSchema = z.object({
  fit: matchSchema.shape.fit,
  action: z.enum(["keep","revise_pending","repair_sent","ask_action","defer"]),
  target: z.enum(["s1","s2"]).nullable(),
  answer: z.string().min(1).max(750), refs,
  memory: z.enum(["no_change","propose_scoped_update","await_confirmation"])
}).strict();
const readRequest = z.object({ read: z.array(z.string()).min(1).max(4) }).strict();
const base = "你只能使用本位角色可见、实际读过的原文。来源目录、检查问题和假设都不是事实。用户对回执的陈述与独立核验分开。仅返回JSON。第一轮可用{\"read\":[\"来源ID\"]}请求至多四项原文，另有一次提交机会。";
const instructions = {
  match: base + '职责：核查该岗位的条件、适用范围及例外。返回{"fit":"fits/conflict/exception/uncertain选一","reason":"简短依据","refs":["实际已读的来源ID"]}。uncertain用于前提改变仍待确定。不要代替报告专家决定纠正动作。',
  report: base + '职责：基于岗位专家的交接、旧报告和用户事实决定是否要纠正已交付建议，若要纠正，考虑用户已做了什么。不要替用户执行外部动作。返回{"fit":"fits/conflict/exception/uncertain选一","action":"keep/revise_pending/repair_sent/ask_action/defer选一","target":"原句ID或null","answer":"向学生说的自然语言","refs":["实际已读来源ID"],"memory":"no_change/propose_scoped_update/await_confirmation选一"}。三种记忆动作只记录建议，不执行写入。'
};

export function parseReply(raw) {
  return JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, ""));
}
export function writePrompt(initial, job) {
  return [{role:"system",content:probePrompt},{role:"user",content:JSON.stringify({
    target:initial.staticCard.anchor, delivery:initial.delivery,
    sources:{jd:job.jd,u0:initial.request.request}
  })}];
}

export function sourcesFor(role, initial, job, branch, match) {
  const entries = [{id:"u0",label:"初始用户陈述",text:initial.request.request}];
  for (const [index, turn] of branch.history.entries())
    entries.push({id:"h"+(index+1),label:"此前第"+(index+1)+"条用户原话",text:turn.reply});
  if (role === "match") entries.push({id:"jd",label:"岗位说明",text:job.jd});
  else {
    entries.push({id:"delivery",label:"已交付报告原文",text:JSON.stringify(initial.delivery.sentences)});
    entries.push({id:"match",label:"本轮获准的岗位专家交接",text:JSON.stringify(match)});
  }
  return entries;
}
export function project(role, arm, initial, probe) {
  if (arm === "A") return undefined;
  const card = { sentence:initial.staticCard.anchor, report:initial.delivery.id,
    version:initial.delivery.version, premiseRefs:initial.staticCard.premiseRefs };
  if (arm === "C" && probe) {
    card.trigger = probe.trigger;
    if (role === "match") card.exceptionQuestion = probe.exceptionQuestion;
    else card.lookFor = probe.lookFor;
  }
  if (estimateTokens(JSON.stringify(card)) > 400) throw Error("Projection exceeds its reserved size");
  return card;
}

// Both budgets see identical initial messages, including the same distractors.
export function pack(role, arm, budget, initial, branch, probe, catalog, requested = []) {
  const chosen = catalog.filter((e) => requested.includes(e.id));
  const task = { role, update:{id:"now",text:branch.update.reply},
    available:catalog.map(({id,label})=>({id,label})), adviceCheck:project(role,arm,initial,probe),
    requestedSources:chosen, readRemaining:requested.length ? 0 : 1 };
  const messages = [{role:"system",content:instructions[role]},
    {role:"user",content:"TASK_DATA\n"+JSON.stringify(task)}];
  const sourceMessages = new Map();
  for (const doc of catalog) {
    const content = "SOURCE\n"+JSON.stringify(doc);
    messages.push({role:"user",content});
    sourceMessages.set(content,doc.id);
  }
  const pages = ["图书馆读书会｜讨论提纲：先概述文章结构，再各自选一段说明理由。",
    "校园开放日｜接待志愿者分组介绍礼堂和运动场，并记录访客问题。"];
  for (let i=0;i<14;i++)
    messages.push({role:"user",content:"无关历史摘录 "+(i+1)+"\n"+pages[i%2].repeat(9)});
  messages.push({role:"user",content:"依据已读材料和当前任务提交 JSON。".padEnd(380," ")});
  const packed = compactMessages(messages,budgets[budget]);
  const seen = new Set(["now",...chosen.map((r)=>r.id)]);
  for (const m of packed.messages)
    if (sourceMessages.has(m.content)) seen.add(sourceMessages.get(m.content));
  const needed = role==="match" ? ["jd"] : ["delivery","match"];
  const missing = needed.filter((id)=>!seen.has(id));
  const requestMode = !requested.length && missing.length>0;
  const direction = requestMode
    ? "现在仅选择回读来源。返回一个含 read 数组的 JSON，必须包含 "+missing.join("、")+"，剩余名额可选与本次变化相关的用户原话。总数至多四项。"
    : "现在处于最终提交阶段，回读已完成或所需来源均已显示。直接按本角色的业务输出格式提交，只能引用这些已读来源ID："+[...seen].join("、")+"。本轮不接受 read。";
  packed.messages[packed.messages.length-1]={role:"user",content:direction};
  if(estimateTokens(JSON.stringify(packed.messages))>budgets[budget]) throw Error("Phase instruction exceeds budget");
  return {messages:packed.messages,removed:packed.removed,seen:[...seen]};
}

export async function runRole({role, arm, budget, initial, job, branch, probe, match, call}) {
  const catalog = sourcesFor(role,initial,job,branch,match);
  const allowed = new Set(catalog.map((r)=>r.id));
  const trace = [];
  let requested = [];
  for (let pass=0;pass<2;pass++) {
    const packed = pack(role,arm,budget,initial,branch,probe,catalog,requested);
    const raw = await call(role+"-"+pass,packed.messages);
    trace.push({removed:packed.removed,seen:packed.seen,requested});
    const reply = parseReply(raw);
    if (!pass && Object.hasOwn(reply,"read")) {
      requested = [...new Set(readRequest.parse(reply).read)];
      if (requested.some((id)=>!allowed.has(id))) throw Error("Source outside role directory");
      continue;
    }
    const value = (role==="match" ? matchSchema : reportSchema).parse(reply);
    if (value.refs.some((id)=>!packed.seen.includes(id))) throw Error("Source was not actually read");
    if (role==="report" && value.target && !packed.seen.includes("delivery"))
      throw Error("Targeted advice without reading its delivered text");
    return {value,trace};
  }
}
