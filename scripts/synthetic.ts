import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { ROOT, hash } from "../src/config.js";
import { Category, Dataset, Dimensions, Edge, Job } from "../src/contracts.js";
import { writeDataset } from "../src/data.js";
const categories: Category[] = [
  {
    id: "frontend-junior",
    title: "初级前端开发",
    family: "frontend",
    level: "junior",
    summary: "Vue TypeScript 网页组件开发与测试",
    skills: ["Vue", "TypeScript", "Git", "CSS"],
    abilities: {},
  },
  {
    id: "frontend-mid",
    title: "中级前端开发",
    family: "frontend",
    level: "mid",
    summary: "前端工程化、性能优化、复杂应用",
    skills: ["Vue", "TypeScript", "性能优化", "测试"],
    abilities: {},
  },
  {
    id: "frontend-senior",
    title: "高级前端开发",
    family: "frontend",
    level: "senior",
    summary: "前端架构、团队协作、技术决策",
    skills: ["架构", "TypeScript", "性能优化", "协作"],
    abilities: {},
  },
  {
    id: "backend-junior",
    title: "初级后端开发",
    family: "backend",
    level: "junior",
    summary: "Java SQL Spring 接口开发",
    skills: ["Java", "SQL", "Spring", "Git"],
    abilities: {},
  },
  {
    id: "backend-mid",
    title: "中级后端开发",
    family: "backend",
    level: "mid",
    summary: "服务设计、数据库优化、并发处理",
    skills: ["Java", "SQL", "Redis", "测试"],
    abilities: {},
  },
  {
    id: "qa-junior",
    title: "初级测试开发",
    family: "qa",
    level: "junior",
    summary: "接口测试、自动化测试和缺陷分析",
    skills: ["测试", "Python", "SQL", "Git"],
    abilities: {},
  },
];
const edges: Edge[] = [
  {
    source: "frontend-junior",
    target: "frontend-mid",
    type: "promotion",
    score: 0.85,
    reason: "工程化与性能优化能力进阶",
  },
  {
    source: "frontend-mid",
    target: "frontend-senior",
    type: "promotion",
    score: 0.75,
    reason: "架构与团队协作要求提升",
  },
  {
    source: "frontend-junior",
    target: "qa-junior",
    type: "transfer",
    score: 0.65,
    reason: "复用网页测试经验，补充自动化脚本",
  },
  {
    source: "backend-junior",
    target: "backend-mid",
    type: "promotion",
    score: 0.82,
    reason: "数据库与服务设计进阶",
  },
  {
    source: "backend-junior",
    target: "qa-junior",
    type: "transfer",
    score: 0.7,
    reason: "复用接口与数据库能力",
  },
];
const jobs: Job[] = categories.flatMap((c, ci) =>
  ["成都", "西安", "北京", "杭州"].map((city, i) => ({
    id: `synthetic-${ci + 1}-${i + 1}`,
    title: c.title,
    city,
    categoryId: c.id,
    family: c.family,
    level: c.level,
    company: `合成样本公司${ci + 1}-${i + 1}`,
    source: `synthetic://jobs/${ci + 1}-${i + 1}`,
    updatedAt: "2026-10-15",
    jd: `${city} ${c.title}。要求 ${c.skills.join("、")}，职责包括 ${c.summary}。${i === 2 ? "工作制待确认" : "周末双休"}。本条是实验合成岗位，不是真实招聘。`,
    salaryMin: 6000 + ci * 1000,
    salaryMax: 9000 + ci * 1500,
    educationRank: 3,
    experienceMin: c.level === "junior" ? 0 : c.level === "mid" ? 2 : 4,
    weekendsOff: i === 2 ? null : true,
    skills: c.skills,
  })),
);
const content = { jobs, categories, edges, documents: [] };
const data: Dataset = {
  version: hash(content),
  label: "Synthetic career fixtures v1 - not real vacancies",
  source: "synthetic",
  ...content,
};
writeDataset(resolve(ROOT, "data/synthetic/dataset.json"), data);
mkdirSync(resolve(ROOT, "evals/examples"), { recursive: true });
const request = {
  userId: "synthetic-user",
  conversationId: "demo-001",
  request:
    "请根据我的简历建立能力画像，推荐成都适合应届生的前端岗位，再制定成长路径并形成报告。",
  resumeText:
    "本科计算机专业，应届毕业生。\n独立完成 Vue 和 TypeScript 校园活动报名网站，使用 Git 管理代码，实现了报名表单和 CSS 响应式布局。\n为表单编写测试，修复了重复提交问题；与两名同学协作整理需求。\n暂无企业实习经历。希望在成都工作，周末双休。",
  constraints: {
    cities: ["成都"],
    education: "本科",
    experienceYears: 0,
    weekendsOff: true,
    skills: ["Vue", "TypeScript", "Git", "CSS"],
    pathMode: "balanced",
  },
  architecture: "multi-agent",
  approvalRequired: false,
};
writeFileSync(
  resolve(ROOT, "evals/examples/full-plan.json"),
  JSON.stringify(request, null, 2),
);
writeFileSync(
  resolve(ROOT, "evals/examples/profile.json"),
  JSON.stringify(
    {
      ...request,
      conversationId: "profile-001",
      request: "仅分析我的简历，建立有证据的12维能力画像，说明缺失信息。",
    },
    null,
    2,
  ),
);
for (const role of ["profile", "match", "path", "report"]) {
  const dir = resolve(ROOT, `skills/${role}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "SKILL.md"),
    `---\nname: ${role}\ndescription: Career planning ${role} capability with scoped tools and knowledge\n---\n\n<!-- Generated from prompts/${role}.md by npm run synthetic; do not edit independently. -->\n\n${readFileSync(resolve(ROOT, `prompts/${role}.md`), "utf8")}`,
  );
}
console.log(
  JSON.stringify({
    dataset: data.version,
    jobs: jobs.length,
    categories: categories.length,
    edges: edges.length,
    examples: 2,
    skills: 4,
  }),
);
