// 成员模型继承错误（0.4.0）：成员模型唯一路线 = 跟随 Lead 最新已确认选择。
// provider 层在解析/继承失败时抛出本类型；backend 捕获后转 TEAM_INVALID_ARGUMENT——
// message 原样透出给用户（Lead 会转述），绝不包装成「成功但降级」。
// 与「未持久接收」（TEAM_PROVISIONING_CONFLICT）区分：本错误 = 明确不可继承的原因。

/** Lead 模型选择不可继承（官方套餐 / 目录外 / 解析不出 / setModel 被拒）。 */
export class ModelInheritanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelInheritanceError";
  }
}
