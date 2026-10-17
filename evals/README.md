# 示例与验证场景

- examples/：CLI请求JSON；reply.json与correction.json用于续接已有任务，其余示例用于run。
- configs/：可复用运行配置，不包含凭证或私有运维信息。
- suites/：开发场景清单，不作为独立封存测试或人工金标准。

使用方法见[运行指南](../docs/architecture/runtime-usage.md)，开发检查见[开发说明](../docs/development/contributing.md)。可复用入口包括[benchmark](../scripts/benchmark.ts)、[配对运行](../scripts/compare.ts)、[分析](../scripts/compare-analyze.ts)与[归档](../scripts/archive-experiment.ts)。默认CI不发起真实供应商调用。

公开最终结论和统计见[评估目录](../docs/evaluation/README.md)。逐日过程、原始运行和评审材料保存本地，不随本目录发布。
