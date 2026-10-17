# 工程测试地图

运行npm run check完成类型检查、构建与测试。默认测试使用合成材料和明确回放，不调用真实模型供应商。

| 范围                 | 主要入口                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 协调、依赖失效与恢复 | [coordination](coordination.test.ts)、[process](process.test.ts)、[tool-protocol](tool-protocol.test.ts)                                                                 |
| 用户续接与输入       | [follow-up](follow-up.test.ts)、[input-evidence](input-evidence.test.ts)、[input-completion](input-completion.test.ts)、[history-runtime](history-runtime.test.ts)       |
| 追问与当前状态       | [clarification](clarification.test.ts)、[open-questions](open-questions.test.ts)、[execution-state](execution-state.test.ts)                                             |
| 记忆与跨轮边界       | [memory](memory.test.ts)、[multiturn](multiturn.test.ts)、[memory-calculation](memory-calculation.test.ts)                                                               |
| 检索与压缩后工作状态 | [retrieval-memory](retrieval-memory.test.ts)、[working-set](working-set.test.ts)                                                                                         |
| 来源和声明核验       | [source-fields](source-fields.test.ts)、[review-evidence](review-evidence.test.ts)、[review-scope](review-scope.test.ts)、[review-submission](review-submission.test.ts) |
| 传输与模型协议       | [provider](provider.test.ts)、[provider-request](provider-request.test.ts)、[stream-runtime](stream-runtime.test.ts)                                                     |
| 评估材料与统计工具   | [blind-conversations](blind-conversations.test.ts)、[human-review](human-review.test.ts)、[review-tool-observations](review-tool-observations.test.ts)                   |

真实子进程退出测试验证有限持久化窗口，不承诺任意时刻故障都无损。来源定位不证明语义支持；回放不能证明模型质量。新增测试应验证有意义的不变量、边界或失败恢复，避免只复述实现。

完整规则见[开发说明](../docs/development/contributing.md)，当前能力见[实现状态](../docs/development/implementation-status.md)，业务观察见[最终统计](../docs/evaluation/results.md)。
