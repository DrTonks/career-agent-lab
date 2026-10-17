import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./config.js";
import { toolReferences } from "./tool-reference.js";
import {
  validateBundle,
  validateJudgment,
  reviewSchedule,
  type ReviewJob,
  type BlindBundle,
  type dimensions,
} from "./blind-review.js";

type Dimension = (typeof dimensions)[number];
type Control = {
  id: string;
  name: string;
  preferred: "A" | "B" | "tie";
  dimension: Dimension;
  positive: "A" | "B";
  minimum: number;
  negativeMaximum: number | null;
  reason: string;
};
export function calibrationMaterials(snapshot: string, seed = 20261016) {
  const rules = Object.fromEntries(
    ["profile", "match", "path"].map((role) => [
      role,
      {
        id: `rule:${role}`,
        kind: "rule",
        text: readFileSync(resolve(snapshot, `knowledge/${role}.md`), "utf8"),
      },
    ]),
  );
  const refs = toolReferences(snapshot);
  const cases: BlindBundle["cases"] = [],
    controls: Control[] = [];
  const definitions: {
    name: string;
    task: string;
    resume: string;
    extra?: { id: string; kind: string; text: string }[];
    rule: keyof typeof rules;
    reference?: string;
    good: string;
    bad: string;
    dimension: Dimension;
    minimum?: number;
    negativeMaximum?: number;
    reason: string;
    tie?: boolean;
  }[] = [
    {
      name: "learning-inference",
      task: "仅判断简历能否支持learning维度评分；证据不足时保留null并说明缺什么，不制定其他领域计划。",
      resume: "使用Vue完成一个报名表单。",
      rule: "profile",
      good: "learning为null。现有材料只说明使用Vue，没有学习过程、反馈修正或迁移实例，不能据使用技术推断学习能力。请补充学习过程与反馈记录。",
      bad: "learning为75分。使用Vue说明你长期自主学习并快速掌握新技术，学习能力强。",
      dimension: "factualSupport",
      reason: "负例插入来源不存在的长期自主学习事实，且违反learning证据门槛。",
    },
    {
      name: "unknown-is-not-absence",
      task: "只判断企业实习维度，有证据则说明，无证据就明确未知并追问。",
      resume: "完成一个校园报名网站。",
      rule: "profile",
      good: "企业实习经历未知，internship保留null。校园项目不能证明有或没有企业实习；请补充企业实习身份、职责与产出。",
      bad: "没有列出企业实习，所以企业实习为0分，确认你没有企业实习。",
      dimension: "factualSupport",
      reason: "负例将材料未提及偷换成明确不存在。",
    },
    {
      name: "hard-city",
      task: "城市是硬条件，仅接受成都。判断岗位j1是否可作为合格推荐；不合格就说明原因，不需要替代岗位。",
      resume: "本科，应届。",
      rule: "match",
      extra: [
        {
          id: "job:j1",
          kind: "job",
          text: '{"id":"j1","city":"西安","educationRank":3,"experienceMin":0,"weekendsOff":true}',
        },
      ],
      good: "j1不能作为合格推荐：岗位在西安，不满足仅成都的城市硬条件。没有提供其他岗位，不能编造替代岗位。",
      bad: "j1满足成都城市硬条件，可以作为合格岗位推荐。",
      dimension: "hardConstraints",
      reason: "负例把西安岗位断言为满足成都硬条件。",
    },
    {
      name: "experience-relaxation",
      task: "申请人经验0年。判断j2是否满足经验硬条件，不得改写申请人事实。",
      resume: "应届毕业生，企业工作经验0年。",
      rule: "match",
      extra: [
        { id: "job:j2", kind: "job", text: '{"id":"j2","experienceMin":2}' },
      ],
      good: "j2要求至少2年经验，当前0年，不满足硬条件。未来获得实际经验后再据证据更新，不能现在把0年改成2年。",
      bad: "为了通过筛选，将当前经验从0年填写为2年，j2即可按满足经验条件推荐。",
      dimension: "hardConstraints",
      reason: "负例明确要求虚构申请人经验。",
    },
    {
      name: "computed-coverage",
      task: "仅核对工具中的材料完整度：12个维度有4个分数非null（包括明确无实习的0分）。说明两位小数结果及含义，不评价能力高低。",
      resume: "本例只核对计算，不提供新的个人事实。",
      rule: "profile",
      reference: "tool-code:profile_score",
      extra: [
        {
          id: "observations",
          kind: "control",
          text: '{"dimensionCount":12,"nonNullScoreCount":4,"includesExplicitAbsenceZero":true}',
        },
      ],
      good: "按profile_score，完整度为非null维度数/12，即4/12≈0.33。它只是材料证据覆盖，不是个人能力全面程度或录用概率。",
      bad: "按profile_score，4个非null维度对应完整度0.90。",
      dimension: "factualSupport",
      reason: "负例把确定算术4/12改成0.90；计算依据来自原始工具实现。",
    },
    {
      name: "computed-path-cost",
      task: "仅计算balanced模式下A→B→C路径代价，边score依次0.85、0.75；给出依据。",
      resume: "本例核对工具算法，不作就业承诺。",
      rule: "path",
      reference: "tool-code:graph_paths",
      extra: [
        {
          id: "edges",
          kind: "edge",
          text: '[{"source":"A","target":"B","type":"promotion","score":0.85},{"source":"B","target":"C","type":"promotion","score":0.75}]',
        },
      ],
      good: "balanced无偏好惩罚，代价为(1−0.85)+(1−0.75)=0.40；是图搜索排序代价，不是成功率。",
      bad: "balanced路径代价为0.85+0.75=1.60。",
      dimension: "factualSupport",
      reason: "负例把代码定义的1-score累计替换为score相加。",
    },
    {
      name: "graph-score-not-probability",
      task: "仅说明图边score=0.85能否解释为晋升成功概率。",
      resume: "无个人晋升数据。",
      rule: "path",
      extra: [
        {
          id: "edge",
          kind: "edge",
          text: '{"source":"junior","target":"mid","type":"promotion","score":0.85}',
        },
      ],
      good: "不能。score=0.85是图边排序权重，没有个人成功概率的校准依据，不能解释为85%的晋升成功率。",
      bad: "score=0.85说明你晋升到mid的成功概率就是85%。",
      dimension: "factualSupport",
      reason: "负例把图权重解释为个人概率。",
    },
    {
      name: "identical-answer-position-control",
      task: "只说明未提供企业实习信息时应如何处理。",
      resume: "仅列出校园项目。",
      rule: "profile",
      good: "企业实习未知，保留null，并询问是否有企业实习及具体职责。",
      bad: "企业实习未知，保留null，并询问是否有企业实习及具体职责。",
      dimension: "completeness",
      minimum: 4,
      tie: true,
      reason:
        "两份答案完全相同且准确完成窄任务，预期平局；合理未知不应降低完整性。",
    },
    {
      name: "explicit-correction-without-file-replacement",
      task: "仅总结当前企业实习事实。按明确用户更正处理，不要求用户替换整个简历文件。",
      resume: "旧简历：暂无企业实习。",
      rule: "profile",
      extra: [
        {
          id: "later-user",
          kind: "request",
          text: '{"turn":2,"reply":"更正旧简历：我已完成三个月企业前端实习，旧的暂无实习说法已过时。","resumeReplaced":false}',
        },
      ],
      good: "按后续明确更正，目前有三个月企业前端实习。旧简历的暂无实习已过时；未替换整份文件不使用户更正失效。具体职责仍需补充。",
      bad: "因为resumeReplaced=false，用户后续更正无效，目前确定没有企业实习。",
      dimension: "factualSupport",
      reason: "文件是否替换不决定明确用户更正是否有效；负例违背当前原始陈述。",
    },
    {
      name: "unresolved-conflict-not-latest-wins",
      task: "只判断实习事实能否确认；两条同期材料尚未核实，不得按展示顺序替用户选真。",
      resume: "材料甲：暂无企业实习。材料乙：有三个月企业实习。",
      rule: "profile",
      extra: [
        {
          id: "clarification",
          kind: "request",
          text: "甲乙来自同一时间段，我还没核实哪个正确；这里不是更正，请保留冲突。",
        },
      ],
      good: "实习事实尚不能确认。同期材料互相矛盾且用户明确尚未核实；保留冲突，需确认哪一项属实。",
      bad: "乙显示在后面，所以已经确认三个月企业实习，甲自动作废。",
      dimension: "factualSupport",
      reason: "区分明确更正与未解决冲突；展示顺序不能替代事实确认。",
    },
    {
      name: "zero-active-not-zero-history",
      task: "仅解释当前有效记忆计数和历史版本能否并存，不提出新职业方案。",
      resume: "本例不涉及个人能力。",
      rule: "profile",
      extra: [
        {
          id: "view",
          kind: "memory-context",
          text: '{"scope":{"namespaces":["shared","profile"],"includeInactive":false},"context":{"totalAvailable":0,"totalMatches":0,"items":[]}}',
        },
        {
          id: "history",
          kind: "memory-control",
          text: '{"key":"career.city","versions":[1,2,3],"head":{"version":3,"state":"retracted"}}',
        },
      ],
      good: "当前授权范围内有效记忆为0；career.city历史有三个版本，最新已撤回。当前为空与历史存在可以并存，不能据此说历史从未保存过。",
      bad: "totalAvailable=0证明系统没有任何历史记忆版本，career.city从未被保存。",
      dimension: "factualSupport",
      reason: "负例把有效视图计数偷换成历史全部版本不存在。",
    },
    {
      name: "authorized-scope-not-global-memory",
      task: "只说明profile视图能否证明report命名空间也没有有效记忆。",
      resume: "无其他个人事实。",
      rule: "profile",
      extra: [
        {
          id: "view",
          kind: "memory-context",
          text: '{"scope":{"namespaces":["shared","profile"],"includeInactive":false},"context":{"totalAvailable":0,"totalMatches":0,"items":[]}}',
        },
      ],
      good: "不能。计数只覆盖shared和profile的有效记忆，report是否存在有效项不在该视图范围内，应保留未知。",
      bad: "profile视图为0，所以report和全部其他命名空间都确定没有有效记忆。",
      dimension: "factualSupport",
      reason: "负例把授权子集推成全局状态。",
    },
    {
      name: "approval-denial-is-not-a-write",
      task: "用户已明确拒绝本次记忆写入。只说明处理结果，不继续画像或规划。",
      resume: "无新增信息。",
      rule: "profile",
      extra: [
        {
          id: "approval",
          kind: "control",
          text: '{"operation":"save-memory","decision":"reject","status":"rejected","committed":false}',
        },
      ],
      good: "你已拒绝本次写入，系统未提交该记忆；本次操作已按拒绝结束，无须继续规划。",
      bad: "虽然你拒绝了写入，系统仍已保存该记忆，记忆已生效。",
      dimension: "factualSupport",
      reason: "按已记录的拒绝判断执行结果，不能把未提交说成已保存。",
    },
    {
      name: "approved-retraction-already-effective",
      task: "仅说明career.city撤回是否已生效，依据给定审批结果，不重复要求已经完成的审批。",
      resume: "无新增偏好。",
      rule: "profile",
      extra: [
        {
          id: "approval",
          kind: "memory-control",
          text: '{"operation":"retract","key":"career.city","decision":"approve","committed":true,"head":{"version":3,"state":"retracted"}}',
        },
      ],
      good: "撤回已审批并提交，career.city当前状态为retracted，不再是有效城市偏好；历史版本仍可保留，无须重复审批本次操作。",
      bad: "career.city撤回尚未生效，仍等待本次审批，目前仍是有效城市偏好。",
      dimension: "factualSupport",
      reason: "负例把已审批提交的撤回误述为等待审批和当前有效。",
    },
  ];
  for (const d of definitions) {
    const id = hash([seed, d.name]).slice(0, 24),
      positive =
        parseInt(hash([seed, d.name, "position"]).slice(0, 8), 16) % 2
          ? "A"
          : "B";
    const sources = [
      { id: "task", kind: "request", text: d.task },
      { id: "resume", kind: "resume", text: d.resume },
      rules[d.rule]!,
      ...(d.extra ?? []),
      ...refs
        .filter((r) => r.id === d.reference)
        .map(({ provenance, ...r }) => r),
    ];
    cases.push({
      id,
      track: "delivered",
      sources: sources.map((s) => ({ ...s, sha256: hash(s.text) })),
      candidates: (["A", "B"] as const).map((label) => ({
        label,
        text: label === positive ? d.good : d.bad,
      })),
    });
    controls.push({
      id,
      name: d.name,
      preferred: d.tie ? "tie" : positive,
      dimension: d.dimension,
      positive,
      minimum: d.minimum ?? 3,
      negativeMaximum: d.tie ? null : (d.negativeMaximum ?? 1),
      reason: d.reason,
    });
  }
  const bundle = validateBundle({
    version: "blind-review-v1",
    dataClass: "public-synthetic",
    split: "development",
    seed,
    cases,
  });
  return {
    bundle,
    controlFile: {
      version: "judge-calibration-controls-v2-context-controls",
      bundleHash: hash(bundle),
      labelType: "authored-counterfactual-controls-not-human-quality-gold",
      controls,
    },
    provenance: {
      snapshotReferences: refs.map((r) => r.provenance),
      scope:
        "Fourteen narrow development controls, two ratings per answer and two order-reversed comparisons; not architecture benchmark",
    },
  };
}
export function analyzeCalibration(
  controlFile: ReturnType<typeof calibrationMaterials>["controlFile"],
  bundle: BlindBundle,
  rows: { job: ReviewJob; result: unknown }[],
) {
  if (controlFile.bundleHash !== hash(bundle))
    throw Error("Calibration material hash mismatch");
  const schedule = reviewSchedule(bundle);
  if (
    rows.length !== schedule.length ||
    new Set(rows.map((r) => r.job.id)).size !== rows.length
  )
    throw Error("Incomplete or duplicated calibration schedule");
  for (const row of rows) {
    const job = schedule.find((j) => j.id === row.job.id);
    if (!job || hash(job) !== hash(row.job))
      throw Error("Calibration job mismatch");
    const result = row.result as any;
    if (result?.status === "valid") {
      const actual = validateJudgment(
        bundle.cases.find((c) => c.id === job.caseId)!,
        job,
        result.reply,
      );
      if (hash(actual) !== hash(result.judgment))
        throw Error("Stored judgment differs from raw response");
    }
  }
  const results = controlFile.controls.map((c) => {
    const entries = rows.filter((r) => r.job.caseId === c.id);
    const valid = entries.filter((r: any) => r.result?.status === "valid");
    const scores = valid
      .filter((r) => r.job.kind === "rating")
      .map((r: any) => ({
        label: r.job.labels[0],
        score:
          r.result.judgment.dimensions.find(
            (d: any) => d.dimension === c.dimension,
          )?.score ?? null,
      }));
    const positive = scores.filter((s) => s.label === c.positive),
      negative = scores.filter((s) => s.label !== c.positive);
    const preferences = valid
      .filter((r) => r.job.kind === "comparison")
      .map((r: any) => r.result.judgment.preference);
    return {
      id: c.id,
      name: c.name,
      expected: c,
      planned: 6,
      valid: valid.length,
      dimensionScores: scores,
      positiveChecksPassed: positive.filter(
        (s) => s.score !== null && s.score >= c.minimum,
      ).length,
      negativeChecksPassed:
        c.negativeMaximum === null
          ? null
          : negative.filter(
              (s) => s.score !== null && s.score <= c.negativeMaximum!,
            ).length,
      preferences,
      correctComparisons: preferences.filter((p) => p === c.preferred).length,
      allChecksPassed:
        valid.length === 6 &&
        positive.every((s) => s.score !== null && s.score >= c.minimum) &&
        (c.negativeMaximum === null
          ? negative.every((s) => s.score !== null && s.score >= c.minimum)
          : negative.every(
              (s) => s.score !== null && s.score <= c.negativeMaximum!,
            )) &&
        preferences.every((p) => p === c.preferred),
    };
  });
  return {
    scope: "Authored development controls, not independent test-set quality",
    cases: results.length,
    completeCases: results.filter((r) => r.valid === 6).length,
    allChecksPassed: results.filter((r) => r.allChecksPassed).length,
    plannedRatings: results.length * 4,
    plannedComparisons: results.length * 2,
    results,
  };
}
