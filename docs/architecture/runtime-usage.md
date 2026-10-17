# 运行与配置

从[项目首页](../../README.md)完成安装，使用 `.env.example` 配置模型服务。`--live` 明确启用真实调用；工程回放不代表真实模型输出，失败不会自动换成演示答案。

## 任务与容量

画像示例为 `evals/examples/profile.json`，完整规划为 `evals/examples/full-plan.json`。默认配置偏向短任务；完整规划包含检索、工具交互、综合和核验，可以在新任务开始前加载现有完整任务配置：

```powershell
$capacity = Get-Content evals/configs/full-task.json -Raw | ConvertFrom-Json
foreach ($setting in $capacity.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($setting.Name, [string]$setting.Value, 'Process')
}
npm run cli -- run --case evals/examples/full-plan.json --architecture multi-agent --live --events
```

该配置目前保存在 `evals/configs/`，内容也是通用运行时环境变量。它放宽总调用、累计输入输出、单次上下文及专家/总控轮数，仍保留最终核验容量、权限和引用规则。默认值和环境变量见 [.env.example](../../.env.example)；有效配置进入运行指纹。恢复旧任务必须保持原配置，不能中途换档。最终核验与容量关系见[核验设计](final-review.md)。

## 混合检索

```powershell
npm run cli -- index build --dataset data/synthetic/dataset.json --out data/indexes/synthetic-rubric-v2
npm run cli -- run --case evals/examples/full-plan.json --index data/indexes/synthetic-rubric-v2 --live
```

首次建库按配置下载本地 embedding 模型，缓存位于 `.models/`。索引绑定模型 revision、前缀、切块和数据指纹。没有索引时使用 BM25；云端资源有限时可以由独立工作节点持有索引。

## 多轮、审批与恢复

```powershell
npm run cli -- inspect --run RUN_ID --user USER_ID
npm run cli -- reply --run PARENT_RUN_ID --user USER_ID --case evals/examples/reply.json --live
npm run cli -- approve --run RUN_ID --user USER_ID --approval APPROVAL_ID --live
npm run cli -- reject --run RUN_ID --user USER_ID --approval APPROVAL_ID --live
npm run cli -- resume --run RUN_ID --user USER_ID --live
npm run cli -- cancel --run RUN_ID --user USER_ID
npm run cli -- memory --user USER_ID
npm run cli -- forget --user USER_ID --confirm
```

`reply` 接收新输入并创建子任务；`resume` 恢复相同输入的执行位置。`approve/reject` 对固定审批快照操作。自定义 `--db`、`--dataset`、`--index` 时，后续操作保持一致。`--events` 输出真实事件；恢复、租约和结果未知的边界见[恢复设计](recovery.md)。

`partial` 可能是缺材料，也可能包含失败，应检查专家状态。`withheld` 表示综合答复未发布，保留的草稿不能直接作为已核验建议。内部 `model_checked` 仅表示当次核验没有继续阻断，不是外部质量保证。
