import { z } from "zod";
import * as legacy from "../advice-repair/protocol.mjs";
import { compactMessages } from "../../dist/src/runtime.js";
import { estimateTokens } from "../../dist/src/config.js";
export { parseReply, sourcesFor } from "../advice-repair/protocol.mjs";

export const budgets = { wide: 20000, tight: 2800 };
Object.assign(legacy.budgets, budgets);
export const arms = ["O", "B", "L", "N"];
export const probeKinds = ["old", "guarded"];

const safeSchema = z.object({
  anchor: z.literal("s1"),
  checks: z.array(z.object({
    slot: z.enum(["execution", "permission", "receipt"]),
    quote: z.string().min(2).max(100)
  }).strict()).min(1).max(3)
}).strict();
const checksText = {
  execution: "是否曾对本岗执行这条建议？只按真实行为记录判断。",
  permission: "是否有明确针对本人及本岗位、覆盖当前变更的书面例外？查到证据后才确认。",
  receipt: "如果已提交、已报名或已登记，最近回执是什么？对照当前条件或已批准例外，判断记录是否需要变更。"
};
export function writePrompt(initial, job, kind) {
  if (kind === "old") return legacy.writePrompt(initial, job);
  return [
    { role: "system", content: "当前是首次交付时刻。你只知道岗位、当时用户陈述和已交付原句。为建议选择未来值得查询的事项，输出 {anchor:s1, checks:[{slot:execution/permission/receipt之一,quote:岗位说明中逐字连续原文}]} 的合法JSON。execution是是否实际执行，permission是本岗位个人例外是否存在，receipt是如已执行则查看最近回执。每个slot最多一次，选1至3项。只依据岗位原文选项，不编造未来行为或当前已有许可。query文本由程序根据选择生成。"}
    , { role: "user", content: JSON.stringify({ delivery: initial.delivery,
      sources: { jd: job.jd, u0: initial.request.request } }) }
  ];
}
export function validateProbe(raw, initial, job, kind) {
  if (kind === "old") {
    const p = legacy.probeSchema.parse(legacy.parseReply(raw)).probe;
    if (p && p.anchor !== initial.staticCard.anchor) throw Error("Wrong advice anchor");
    return p;
  }
  const p = safeSchema.parse(legacy.parseReply(raw));
  if (new Set(p.checks.map((c) => c.slot)).size !== p.checks.length)
    throw Error("Duplicate query slot");
  for (const c of p.checks)
    if (!job.jd.includes(c.quote)) throw Error("Query basis is not a verbatim JD span");
  return p;
}
export function project(role, arm, initial, probes) {
  const card = { report: initial.delivery.id, version: initial.delivery.version,
    anchor: initial.staticCard.anchor, premiseRefs: initial.staticCard.premiseRefs };
  if (arm === "L" && probes.old) {
    if (role === "match") card.questions = [probes.old.trigger, probes.old.exceptionQuestion];
    else card.questions = [probes.old.trigger, ...probes.old.lookFor];
  }
  if (arm === "N" && probes.guarded) {
    card.questions = probes.guarded.checks.filter((c) => role === "report" || c.slot === "permission")
      .map((c) => ({ query: checksText[c.slot], basis: c.quote }));
    card.kind = "conditional_queries";
  }
  if (estimateTokens(JSON.stringify(card)) > 600) throw Error("Projection exceeds 600 estimated tokens");
  return card;
}

const refs = z.array(z.string()).max(12);
const fitSchema = z.enum(["fits", "conflict", "exception", "uncertain"]);
const factSchema = z.object({
  fit: fitSchema, reason: z.string().min(1).max(400), refs: refs.min(1)
}).strict();
const reportSchema = z.object({
  execution: z.enum(["not_started", "started", "unknown"]),
  executionRefs: refs,
  record: z.enum(["none", "stale", "current", "unknown"]),
  recordRefs: refs,
  answer: z.string().min(1).max(650),
  refs: refs.min(1)
}).strict();

export function deriveAction(fit, execution, record) {
  if (fit === "uncertain") return "defer";
  if (fit === "fits") return execution === "started" && record === "stale" ? "repair_sent" : "keep";
  if (fit === "conflict") return { not_started: "revise_pending", started: "repair_sent", unknown: "ask_action" }[execution];
  if (execution === "not_started") return "keep";
  if (execution === "unknown" || record === "unknown") return "ask_action";
  return record === "stale" ? "repair_sent" : "keep";
}
const common = "仅使用本角色实际可见的来源。检查问题是检索线索。岗位允许申请例外，不能证明某人已取得例外；缺少行为记录必须标unknown。用户转述回执按转述处理。仅输出JSON，第一轮可返回带read数组的对象，最多回读四项来源一次。";
const fitDefinitions = "fits=当前满足原始常规条件；exception=原始条件不满足，但已读证据明确确认本岗对本人批准了适用例外；conflict=确定不满足常规条件，且尚无本岗例外获准的证据；uncertain=影响资格的变化仍未生效或确实待定。可申请例外仍为conflict。无需凭是否已报名判断岗位资格。";
const matchPrompt = common + fitDefinitions +
  '你是岗位专家。返回 {"fit":"上述类别之一","reason":"依据","refs":["来源ID"]}。';
const reportPrompt = common + fitDefinitions +
  '当前可到场、可提供材料等资格信息不会证明曾提交或报名。record只指已提交材料、登记表或预约的外部执行状态；此前“尚未报名”的陈述不能因为后来仍符合资格就变成过期记录。' +
  '你是报告专家，本轮资格采用match交接。先判断真实行为。execution=not_started仅用于明确尚未提交/报名/登记；started用于已执行；unknown用于缺少进度证据。record=none仅配not_started；stale表示最新外部记录与当前事实或获准例外不一致；current表示最新外部记录已相符；unknown表示缺少足够回执。' +
  '程序据此计算动作：uncertain→defer；fits→keep（已执行且回执过时则repair_sent）；conflict+未执行→revise_pending，conflict+已执行→repair_sent，conflict+进度未知→ask_action；exception+未执行或已执行且记录最新→keep，exception+已执行且记录过时→repair_sent，exception+必要进度/回执未知→ask_action。' +
  '回答必须与这些状态相符。repair_sent要明确修复已经发生的提交或登记，keep避免重复办已完成事项，ask_action只问能改变下一步的进度问题，defer只做条件式解释。已获例外不证明记录已更新。' +
  '返回 {"execution":"类别","executionRefs":["证据ID，unknown时空数组"],"record":"类别","recordRefs":["证据ID，none/unknown可空数组"],"answer":"给学生的短答","refs":["实际引用来源ID"]}。';

export function pack(role, arm, budget, initial, branch, probes, catalog, requested = []) {
  const task = { role, update: { id: "now", text: branch.update.reply },
    available: catalog.map(({ id, label }) => ({ id, label })),
    adviceCheck: project(role, arm, initial, probes),
    requestedSources: catalog.filter((e) => requested.includes(e.id)) };
  const messages = [{ role: "system", content: role === "match" ? matchPrompt : reportPrompt },
    { role: "user", content: "TASK_DATA\n" + JSON.stringify(task) }];
  const sourceMessages = new Map();
  for (const source of catalog) {
    const content = "SOURCE\n" + JSON.stringify(source);
    sourceMessages.set(content, source.id);
    messages.push({ role: "user", content });
  }
  const pages = ["图书馆读书会｜讨论提纲：先概述文章结构，再各自选一段说明理由。",
    "校园开放日｜接待志愿者分组介绍礼堂和运动场，并记录访客问题。"];
  for (let i = 0; i < 14; i++)
    messages.push({ role: "user", content: "无关历史摘录 " + (i+1) + "\n" + pages[i%2].repeat(9) });
  messages.push({ role: "user", content: "按本轮阶段提交。".padEnd(380, " ") });
  const packed = compactMessages(messages, budgets[budget]);
  const seen = new Set(["now", ...requested]);
  for (const m of packed.messages)
    if (sourceMessages.has(m.content)) seen.add(sourceMessages.get(m.content));
  const required = role === "match" ? ["jd"] : ["delivery", "match"];
  const missing = required.filter((id) => !seen.has(id));
  const direction = !requested.length && missing.length
    ? "此轮只返回带read数组的JSON，必须读" + missing.join("、") + "，其余名额自行选择相关用户原话，总共最多四项。"
    : "原文已显示，直接提交本角色结果；本轮不能再read。实际已读ID：" + [...seen].join("、");
  packed.messages[packed.messages.length - 1] = { role: "user", content: direction };
  if (estimateTokens(JSON.stringify(packed.messages)) > budgets[budget]) throw Error("Context budget exceeded");
  return { messages: packed.messages, seen: [...seen], removed: packed.removed };
}
export async function runRole(options) {
  if (options.arm === "O") return legacy.runRole({ ...options, arm: "C", probe: options.probes.old });
  const { role, arm, budget, initial, job, branch, probes, match, call } = options;
  const catalog = legacy.sourcesFor(role, initial, job, branch, match);
  const trace = [];
  let requested = [];
  for (let pass = 0; pass < 2; pass++) {
    const packed = pack(role, arm, budget, initial, branch, probes, catalog, requested);
    const reply = legacy.parseReply(await call(role + "-" + pass, packed.messages));
    trace.push({ removed: packed.removed, seen: packed.seen, requested });
    if (pass === 0 && Object.hasOwn(reply, "read")) {
      requested = z.array(z.string()).min(1).max(4).parse(reply.read);
      if (requested.some((id) => !catalog.some((e) => e.id === id))) throw Error("Unauthorized source");
      continue;
    }
    const value = (role === "match" ? factSchema : reportSchema).parse(reply);
    const used = role === "match" ? value.refs : [...value.refs, ...value.executionRefs, ...value.recordRefs];
    if (used.some((id) => !packed.seen.includes(id))) throw Error("Cited unread evidence");
    if (role === "report") {
      if (!packed.seen.includes("delivery") || !packed.seen.includes("match")) throw Error("Missing delivery or handoff");
      const rawRecord = value.record;
      if (value.execution === "not_started") value.record = "none";
      if (value.execution === "unknown") value.record = "unknown";
      if (value.execution === "started" && value.record === "none") throw Error("Started action requires a record state");
      if (value.execution !== "unknown" && !value.executionRefs.length) throw Error("Execution state lacks evidence");
      if (["stale", "current"].includes(value.record) && !value.recordRefs.length) throw Error("Record state lacks evidence");
      const action = deriveAction(match.fit, value.execution, value.record);
      return { value: { ...value, rawRecord, fit: match.fit, action,
        target: ["keep", "defer"].includes(action) ? null : initial.staticCard.anchor }, trace };
    }
    return { value, trace };
  }
}
