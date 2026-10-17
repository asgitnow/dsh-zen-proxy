# zen-free-provider Specification

## Purpose
向 dsh 暴露 OpenCode Zen 免费模型的 provider 路由与模型目录，使用户无需手工配置即可在模型选择器中直接使用可用免费模型，并让地区受限的免费模型以独立分组呈现。

## Requirements

### Requirement: 免费模型 provider 注册
插件 SHALL 以 `opencode-free` 与 `opencode-free-region` 两个 provider id 向 `ctx.llm` 注册适配器路由，并在插件卸载时随 fiber 一并释放。

#### Scenario: 挂载后路由可枚举
- **WHEN** 插件在 desktop profile 中挂载完成
- **THEN** `ctx.llm.listProviders()` 的结果包含 id 为 `opencode-free` 与 `opencode-free-region` 的条目，且两条目的 name 均非空

#### Scenario: 卸载后路由消失
- **WHEN** 插件被卸载
- **THEN** `ctx.llm.listProviders()` 不再包含上述两个 id

### Requirement: 目录只公布免费且可用的模型
`opencode-free` 路由的目录 SHALL 只包含模型 id 以 `-free` 结尾、且最近一次探测判定为可用的模型；付费模型、判定不可用的模型与地区受限模型 SHALL NOT 出现在该目录中。

#### Scenario: 付费模型被过滤
- **WHEN** 上游模型清单同时包含以 `-free` 结尾与不以 `-free` 结尾的 id
- **THEN** `opencode-free` 路由的目录只包含以 `-free` 结尾的 id

#### Scenario: 判定不可用的模型被过滤
- **WHEN** 某个免费模型的最近一次探测失败
- **THEN** 该模型不出现在 `opencode-free` 路由的目录中

#### Scenario: 尚未完成首次探测
- **WHEN** 插件刚挂载且本地没有任何历史探测结果
- **THEN** `opencode-free` 路由的目录不包含任何模型，且不抛出错误

### Requirement: 地区受限模型独立分组
地区受限的免费模型 SHALL 只出现在 `opencode-free-region` 路由的目录中。

#### Scenario: 地区受限模型归入地区分组
- **WHEN** 某个免费模型的探测结果为地区受限
- **THEN** 该模型出现在 `opencode-free-region` 路由的目录中，且不出现在 `opencode-free` 路由的目录中

### Requirement: 目录条目自洽
适配器公布的每个模型条目 SHALL 携带与其所属路由一致的 `provider`、非空的 `id` 与非空的 `name`，且同一路由内 `id` MUST NOT 重复。

#### Scenario: 目录通过宿主校验
- **WHEN** `ctx.llm.listModels('opencode-free')` 被调用
- **THEN** 调用成功返回，不抛出 `INVALID_CATALOG`

### Requirement: 能力元数据取自 models.dev 并透传

上游 `GET /zen/v1/models` 实测只返回 `{id, object, created, owned_by}`（无免费标记、无协议族、无上下文窗口、无输出上限、无输入模态），且无可用详情端点（`/zen/v1/models/<id>` 返回 404，`?include=capabilities` 与 `?include=modalities` 返回与基准逐字节相同的响应）。因此能力元数据 SHALL 取自 `https://models.dev/api.json` 的 `opencode` provider，并 SHALL 在进程内缓存（一轮请求至多拉取一次）。适配器 SHALL NOT 编造能力数值，SHALL NOT 依据模型 id 的命名猜测能力，也 SHALL NOT 在仓库内维护静态快照表。

`context.contextWindow` SHALL 取自 `limit.context`、输出容量 SHALL 取自 `limit.output`、输入模态 SHALL 取自 `modalities.input`，三者 SHALL 按 `baseModelId` 归一后的 id 透传。输入模态 SHALL 只声明宿主 `ModelModalityMap` 认识的值（`text`、`image`）：`modalities.input` 含 `image` 时声明 `['text', 'image']`，否则声明 `['text']`；上游另有的 `video`/`audio`/`pdf` SHALL 被忽略，因为它们没有对应的宿主内容块。能力表中没有条目的模型 SHALL 回退为 `['text']` 且省略 `context`，SHALL NOT 因元数据缺失而收缩目录。适配器 SHALL NOT 在精确模型信息中声明 `defaultMaxTokens`；请求体中的输出预算由 `zen-free-upstream-wire` 的「思考预算」需求约束。

能力表拉取失败 SHALL 只降级、不致命：SHALL 省略 `context`、SHALL 按 `['text']` 声明输入模态、SHALL 记录 `CAPABILITIES_UNAVAILABLE`，且 SHALL NOT 中断清单获取与可用性探测。

#### Scenario: 模型信息解析不因元数据缺失而失败

- **WHEN** `ctx.llm.resolveModelInfo('opencode-free', <某个已公布模型 id>)` 被调用
- **THEN** 返回结果包含该模型 id，且不抛出 `INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT` 或 `INVALID_MODEL_MAX_TOKENS`

#### Scenario: 能力表就绪时透传窗口

- **WHEN** 解析的模型在能力表中存在 `limit.context`
- **THEN** 返回结果的 `context.contextWindow` 等于该值且为正整数

#### Scenario: 能力表中没有该模型时省略而非填充

- **WHEN** 解析的模型在能力表中没有条目
- **THEN** 返回结果不含 `context.contextWindow` 也不含 `defaultMaxTokens`，且该模型仍出现在该路由的 `listModels` 结果中

#### Scenario: 输入模态按能力表透传

- **WHEN** 该模型的 `modalities.input` 含 `image`
- **THEN** 其 `inputModalities` 为 `['text', 'image']`；否则为 `['text']`

#### Scenario: 上游声明宿主不认识的多模态类型

- **WHEN** 该模型的 `modalities.input` 含 `video` 或 `audio` 但不含 `image`
- **THEN** 其 `inputModalities` 为 `['text']`，且结果中不出现宿主词汇表以外的模态值

### Requirement: 插件配置面
插件 SHALL 通过 `registerConfigurableProviders` 声明其两个路由，并 SHALL 提供一个可编辑的探测周期配置项，默认值为 10 分钟。

#### Scenario: 配置条目可枚举
- **WHEN** `ctx.llm.listConfigurableProviders()` 被调用
- **THEN** 返回结果包含 provider 为 `opencode-free` 与 `opencode-free-region` 的两个条目，其 displayName 与 settingsNs 均非空

#### Scenario: 探测周期可改
- **WHEN** 用户把探测周期配置改为非默认值
- **THEN** 后续探测按新周期调度，无需重启进程

### Requirement: 不写死用户目录路径
插件 SHALL 通过宿主环境信息解析自身状态目录，并 MUST NOT 在源码中写死任何用户目录绝对路径；唯一允许写死的网络地址是上游 base URL。

#### Scenario: 换用户账户后仍可定位状态目录
- **WHEN** 插件在另一个用户账户下被加载
- **THEN** 插件不读取上一个用户的绝对路径，状态写入由宿主环境解析出的目录

#### Scenario: 源码不含绝对路径
- **WHEN** 审查插件源码
- **THEN** 除上游 base URL 外，不出现任何以盘符或 `/home/`、`/Users/` 开头的用户目录字面量

### Requirement: 思考强度菜单

适配器的精确模型信息 SHALL 声明 `reasoning`，其中 `efforts` 为按展示顺序排列的非空档位数组（每项含非空 `id` 与非空 `name`），`defaultEffort` SHALL 落在该数组内，否则宿主会抛 `INVALID_MODEL_REASONING`。档位 id SHALL 为 `light`、`balanced`、`deep`，默认档位 SHALL 为 `balanced`。适配器 SHALL NOT 依据逐模型的能力标记（例如「能否关闭思考」）决定菜单是否提供或预算取值——该属性在本机没有可溯源来源。档位名称 SHALL 携带**调用方未指定输出上限时**该档将要发出的预算数字；调用方指定更小上限时实际发出的值被收窄，故菜单数字是该档上界而非恒等值。目录（`listModels`）的条目 SHALL NOT 携带 `reasoning`：宿主在该路径只保留 `{provider, id, name, description?, inputModalities?}` 五个字段，多余的键被静默丢弃而不报错，带上去没有作用。

#### Scenario: 精确模型信息通过宿主校验

- **WHEN** `ctx.llm.resolveModelInfo('opencode-free', <某个已公布模型 id>)` 被调用
- **THEN** 返回结果含非空的 `reasoning.efforts` 与位于其中的 `reasoning.defaultEffort`，且不抛出 `INVALID_MODEL_REASONING`

#### Scenario: 宿主接受任一档位

- **WHEN** 调用方以 `light`、`balanced` 或 `deep` 之一请求该模型
- **THEN** 宿主不抛出 `UNSUPPORTED_REASONING_EFFORT`

#### Scenario: 档位名称里的数字与将发出的预算一致

- **WHEN** 读取精确模型信息中某一档位名称里的预算数字，且调用方未指定输出上限
- **THEN** 该数字等于以同档位计算出的请求体预算除以 1024 后四舍五入的结果，即界面呈现的数字与线上发出的数字由同一次计算得出

#### Scenario: 目录条目保持宿主接受的形状

- **WHEN** 请求任一路由的 `listModels`
- **THEN** 每个条目的键集合恰好为 `{provider, id, name, inputModalities}`，不含 `reasoning`
