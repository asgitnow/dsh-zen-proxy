# dsh-zen-proxy

一个 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 插件：
把 **OpenCode Zen 的免费模型车道**接成 dsh 的**原生 llm-provider**。

装上即可在桌面端的模型选择器里直接使用 Zen 的免费模型，**不需要监听端口、不需要写
`settings.yaml`**。插件以官方 OpenCode 客户端的网络身份向上游发请求，每 10 分钟探测一次
可用性，并且**只把「判定为可用」的免费模型放进目录**。

> **2026-10 闸门收紧（本仓库已适配，见下）。** 上游免费车道关闭了匿名访问并升级了身份
> 校验，8 月版的六头伪装已全部失效（`403 FreeTierError`，模型目录恒为空）。现在的要求：
>
> 1. **必须携带真实 API key**——`Bearer public` 匿名车道已关闭。插件按
>    配置 `apiKey` → 环境变量 `OPENCODE_API_KEY` → opencode 凭据库
>    `~/.local/share/opencode/opencode.db` 的 `credential` 表（CLI 里登录过即有；
>    新版 opencode 登录存的是 oauth `access` token，直接当 `Bearer` 用，
>    随重登/令牌轮换自动更新）→ 旧版 `auth.json` 的顺序解析，**每轮与每个请求现读**，
>    换号重登后不用重启；都没有时探测失败并在日志里给出明确指引。
> 2. **session id 必须按官方算法生成**（时间戳 + 随机后缀，出现在四个 session 头里），
>    sha256 派生的会话 id 一律被拒。
> 3. **工具数组必须包含名为 `read` 的工具，且每个工具 `parameters.properties` 非空**
>    （旧的四名字齐备要求已被取代；占位工具已改用官方真实参数 schema）。
> 4. **禁止携带 `x-opencode-request` 头**（真实客户端不发它，带上即被拒）。
>

> **这次改造是破坏性变更。** 旧版本是一个本地 HTTP 代理（监听 `127.0.0.1:4097`，要求用户
> 把 provider 的 `baseURL` 指向它）。代理面、`host`/`port`/`upstream*`/`userAgent` 等配置项
> 已全部移除，也删掉了 `index.js` 里的 `http`/`https` 服务器代码。

---

## 这是什么

dsh 的模型选择器只从适配器的 `listModels` 取模型，而 `listModels` 与
`normalizeModelInfo` 都**没有「不可用」字段**（已核对宿主 `@deepseek-ai/dsh-llm` 的权威
契约）。因此「哪些免费模型现在真的能用」这件事，只能由**路由分组**来表达。插件注册两条路由：

| 路由 id | 分组语义 | 目录内容 |
|---|---|---|
| `opencode-free` | 免费模型（主分组） | 最近一次探测判定为**可用**的免费模型 |
| `opencode-free-region` | 免费模型（地区受限） | 最近一次探测判定为**地区受限**的免费模型 |

两条路由的展示名分别是 `OpenCode Zen 免费模型` 与 `OpenCode Zen 免费模型（地区受限）`。

「免费」的判据是模型 id 以 `-free` 结尾（上游清单里**没有**表示免费的字段，实测清单每项只有
`id` / `object` / `created` / `owned_by`）。付费模型、判定不可用的模型、以及尚未判定完成的
模型都**不会**出现在任何一条路由里。

---

## 安装

### 1. 用桌面端的插件管理器安装（推荐）

在桌面端「设置 → 插件」里安装 `dsh-zen-proxy`（本地 checkout 或 git 地址都可以）。插件管理器会
调用该 profile 自己的包管理器完成安装，并把包名**自动**追加进 `package.json` 的
`dsh.profile.bundles`——这一步是必须的，否则包装上了但不会被当作 profile 层加载。

### 2. 命令行安装（等价做法）

```powershell
dsh plugin --profile desktop add git+https://github.com/Yee-h/dsh-zen-proxy.git
# 或在本地 checkout 时：dsh plugin --profile desktop add file:C:/path/to/dsh-zen-proxy
```

`dsh plugin` 只把参数**透传**给 profile 的包管理器（本机为 pnpm），因此它**不会**替你写
`dsh.profile.bundles`（本机实测：手工移除该条目后重跑 `dsh plugin add`，条目未被加回）。
装完有两种方式补上它：

- **推荐**：让运行中的宿主自己 reconcile——它检测到 `dependencies` 多了一个带 bundle patch 的包时，
  会把它追加进 `dsh.profile.bundles`（本机实测该行为确实发生）。装完重启宿主即可。
- 或手工在 `$DSH_HOME/profiles/desktop/package.json` 里补上：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …已有的 bundle…
        "dsh-zen-proxy"
      ]
    }
  }
}
```

> profile 由 **pnpm** 管理（有 `pnpm-lock.yaml`、`.modules.yaml`），不是 npm 工程。
> 请用 `dsh plugin` 或 `pnpm install`；`npm install` 不会更新 `pnpm-lock.yaml`，
> 会留下与 `.modules.yaml` 不一致的 `node_modules`。

`@deepseek-ai/*`（cordis、dsh-llm、schemastery）由宿主在运行时注入，**不**会（也不应）出现在
profile 的 `node_modules` 里，因此它们只作为本包的 `peerDependencies` 声明。

### 3. 重启宿主

重启 dsh。本包通过自身的 `dsh.bundle.patch`（`cordis.patch.yml`）向 profile 注入 loader 条目：

```yaml
- insert:
    - id: zen-proxy
      name: 'dsh-zen-proxy'
      config: {}
```

本插件**没有浏览器半身**，因此 `package.json` 里刻意不声明 `dsh.client`。

### 4. 不需要任何其它配置

不再需要把某个 provider 的 `baseURL` 指向本地端口，也不再需要 `settings.yaml`。
凭据是池化的 `Bearer public`，无需用户密钥。

---

## 配置

插件有五个配置项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `probeIntervalMinutes` | `10` | 探测周期（分钟）。运行中修改后，**下一轮**起生效，无需重启进程。 |
| `opencodeVersion` | `2.0.24` | 伪装用的 OpenCode 版本（拼进四段式 UA）。低于 `1.18.0` 的值不会被使用，插件会记录一条诊断并回退到门槛值。当前闸门不校验 UA。 |
| `apiKey` | `''`（空） | 免费车道凭据。留空时按 `OPENCODE_API_KEY` 环境变量 → opencode 凭据库 `opencode.db`（CLI 登录过即有）→ 旧版 `auth.json` 解析。每轮与每个请求现读，换号重登或改配置后即生效，无需重启。 |
| `capabilities` | `{}`（空） | 能力覆盖：按模型基名覆盖/补全能力元数据，字段与 models.dev 条目同形（`limit.context` / `limit.output` / `modalities.input`），覆盖侧字段赢。用于修正上游数据或补全 models.dev 缺失的模型（如 `jev-1.13-free`）。每轮从配置现读，改完下一轮生效。 |
| `regionRelayUrl` / `regionRelayToken` | `''`（空） | 区域中继（可选）：部署在非受限出口的转发 Worker 与其令牌。配置后，判定为地区受限的模型改经它探测与对话。 |

`capabilities` 示例（cordis.patch.yml）：

```yaml
- id: zen-proxy
  config:
    capabilities:
      jev-1.13-free:
        limit: { context: 262144, output: 32768 }
        modalities: { input: [text, image] }
```

---

## 清单刷新与目录语义

- **目录不做探测**。2026-10-18 实测：免费配额按会话计，周期探测每 10 分钟新开 9 个会话，
  会把自己打到 `429 FreeUsageLimitError`（7/9 模型同轮限流），再经宽限折算把模型压出目录——
  **探测消耗的正是它想验证的配额**。因此目录直接反映上游清单；模型此刻可不可用，
  由请求路径自己暴露给用户。
- **挂载后立即刷新一轮清单**，且不阻塞挂载（首轮异步发起，目录在首轮返回后填充）。
- 之后**每 10 分钟**（或配置的周期）重复一轮：拉一次 `GET /zen/v1/models` → 按 `-free` 过滤
  → 存目录。**一轮只发这一次请求**，没有逐模型的探测流量。
- **清单拉取失败时本轮作废**，既有目录保持不动，不因一次失败清空选择器。
- **能力表拉取失败只影响元数据声明**（模态回退纯文本、context 省略），不影响目录成员。
- **结果持久化**：最近一次清单写入宿主环境解析出的状态目录
  （`$DSH_HOME/zen-proxy/availability.json`，未设置 `DSH_HOME` 时为宿主配置根下的同名路径），
  采用「先写临时文件再原子改名」。文件缺失或无法解析时按无历史处理，挂载不受影响；
  旧版 v1 判定状态在读取时迁移为 id 列表。因此**重启后目录在首轮刷新完成前就反映上次已知清单**。
- **对话会话稳定派生**：用户对话的会话按对话标识经 sha256 稳定派生，同一对话重启后仍是
  同一会话（免费配额按 session 计，逐请求新造会话会把配额打满）。

---

## 地区分组（按配置指名）

目录不做探测，因此「哪些模型被上游地区闸门拦截」**由配置 `regionModels` 指名**，
不再靠探测的 RegionError 判定。指名者的行为差异：

- 只出现在 `opencode-free-region` 分组，`opencode-free` 里不出现；
- 配置了区域中继时，对话请求经中继收发（上游对地区受限模型返回
  `403 {"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}`，
  状态码与协议族无关）。

每轮从配置现读，改完下一轮刷新即生效。指名了模型但未配置中继时，插件会记录一条
警告（这些模型只能直连，上游会以 RegionError 拒绝当前出口）。

### 区域中继（可选）：让地区受限模型恢复可用

区域判据是**出口 IP 的国家**，而 Cloudflare Worker 的出站请求从 CF 边缘机房发出
（非受限地区 IP），因此一个带令牌鉴权的转发 Worker 可以让这些模型恢复可用。
配套脚本与部署步骤见 [`worker/README.md`](worker/README.md)；部署后给插件加两个
配置项即可启用：

```yaml
- id: zen-proxy
  config:
    regionRelayUrl: https://zen-region-relay.<你的子域>.workers.dev
    regionRelayToken: <与 Worker 的 RELAY_TOKEN secret 相同>
```

生效后的行为：`regionModels` 指名的模型进地区分组，其对话请求经中继收发（带
`x-zen-relay-token` 头）。卸载中继两个字段后这些模型只能直连（当前出口会被上游以
`RegionError` 拒绝）。

---

## 思考强度

模型选择器里的「思考强度」下拉是**插件提供的**，上游没有这个概念。本车道的网关接受
`reasoning_effort`、`thinking.budget_tokens`、`enable_thinking`、`thinking_budget` 之后
**全部忽略**（`low` 产生的思考 token 反而比 `high` 多，未知字段还会偶尔 503；四种拼写的对照
取自参考实现的实测，本机复测的是 `reasoning_effort`，见 `evidence.md` (1)），唯一被执行的强度旋钮是**输出预算上限**。因此宿主需要的 `reasoning.efforts` 菜单由
插件给出，每一档都折算成请求体的 `max_tokens`（chat 族）或 `max_output_tokens`（responses 族）。

| 档位 | 基准输出上限 | 实际发出 | 含义 |
|---|---|---|---|
| `light` · 精简 | 2048 | 2048 × 2 = **4096** | 最短思考，最快给出答案 |
| `balanced` · 均衡（默认） | 8192 | 8192 × 2 = **16384** | 思考与正文各占一半 |
| `deep` · 深度 | 模型容量 | 该模型的输出容量 | 尽量思考，正文可能先被截断 |

- **为什么乘 2**：输出上限同时限制思考与正文，倍率 2 对应「思考占比不超过 50%」这一边界
  （正文 = 2 × 基准 × (1 − 占比)，故占比 ≤ 50% 时档位名里的数字仍是正文的下界）。
  本机复核 `mimo-v2.6-flash-free` 的占比为 33%-43%（`evidence.md` (1)），落在边界内：
  `light` 档实测正文 3117 token（预算 4096、思考 979）。参考实现曾在同一模型上测得约 82%
  （92 次调用，见 `evidence.md` (2b)），该占比与 2 倍系数**不相容**，本机未复现，故未按它标定。
- **容量取自哪里**：`models.dev` 的 `limit.output`，运行时按 id 透传（见 `src/catalog.js`
  的 `CAPABILITIES_URL`）。覆盖率**不是 100%**：2026-10-17 实测上游列出的 9 个免费模型中，
  8 个在 models.dev 有条目，唯一缺口是 `jev-1.13-free`（models.dev 的 127 个 opencode
  条目里没有任何 `jev`）。因此该模型的 `context` 被省略、输出容量回退到 32768，
  它的「深度」档也随之回退。能力表拉取失败时所有模型都走这条回退路径。
- **档位名称里的数字是发出预算的千位表示**：菜单上的 `精简 · 4 K` 与请求体里的 `4096`
  由同一次折算得出，不存在两套算法（回归测试锁死这一点）。容量不是 1024 的整数倍时按
  四舍五入显示，例如 `mimo-v2.6-flash-free` 的容量 32000 显示为 `深度 · 31 K`。
- **调用方上限只收窄不抬高**：宿主或调用方显式指定输出上限时，实际发出的是它与档位预算
  中的**较小者**——档位不会突破调用方上限，调用方上限也不会把档位抬高。预算恒为整数且
  不小于 512——非正数、`NaN`、`Infinity` 一律视为「没有该上限」，不会把回复压没。

---

## 上游协议

- 清单：`GET https://opencode.ai/zen/v1/models`（唯一允许写死的网络地址就是上游 base URL）。
- chat 协议族：`POST https://opencode.ai/zen/v1/chat/completions`。
- responses 协议族：`POST https://opencode.ai/zen/v1/responses`。

协议族按模型 id 判定：`muse-spark*` 走 responses，其余走 chat。**这个判据是间接的，且在本机
无法证真**：上游清单不披露协议族，而这两个 id 走哪条端点都返回 `RegionError`（地区闸门先于
路由判定），因此真实链路无从区分；依据、反证与残留不确定性见
`openspec/changes/archive/2026-10-07-add-opencode-free-provider/evidence.md` 的「协议族的判据（间接；本机无法证真）」。

每个上游请求都带齐六个身份头。其中 `user-agent`（`opencode/` 且不低于 `1.18.0`）与
`x-opencode-*` 是实测的闸门必需项（去掉 `user-agent` 或去掉全部 `x-opencode-*` → `403
FreeTierError`）；`authorization: Bearer public` 是该车道的池化免密凭据，插件始终携带，
但实测单独去掉它仍返回 `200`（见 evidence (2) 的 F 行）：

```text
user-agent: opencode/<version>        # version >= 1.18.0
authorization: Bearer public
x-opencode-client: desktop
x-opencode-project: global
x-opencode-session: ses_<12 hex><14 base62>
x-opencode-request: msg_<12 hex><14 base62>
```

请求体另外要满足两条闸门要求：**流式**（`stream: true`）与**声明工具数组**。工具数组里
小写的 `bash`、`glob`、`grep`、`read` 四个名字必须齐备，缺失的槽位会优先把能真正代答的
调用方工具改名填入（Windows 上宿主的 `pwsh` 填入 `bash` 槽），其余才补一个自禁用占位工具；
响应侧再把被改写的工具名映射回调用方的原始拼写。

---

## 偏离 dsh attribution 契约的说明

宿主 `@deepseek-ai/dsh-llm` 要求**每个** provider HTTP 请求携带 `attributionHeaders()`，
其实测值为：

```text
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
```

而 Zen 免费车道的闸门只接受 `user-agent: opencode/<version>`（且版本不低于 1.18.0）。
两者互斥，**实测对照**（其余五个身份头齐备，同一份请求体）：

| 发送的 `user-agent` | 结果 |
|---|---|
| `opencode/1.18.31` | `200` ✅ |
| `deepseek-harness/<version> (+…)` | `403 FreeTierError`：`OpenCode's free tier can only be used from within OpenCode` |
| `opencode/1.17.0` / 更旧 | `426 UpgradeRequired`：`OpenCode 1.18.0 or newer is required to use the free tier` |

本插件选择**过闸**，因此在这一处覆盖 attribution：`user-agent` 是官方客户端身份，
**不携带任何用户数据**，也不是遥测通道。该偏离在源码中对应位置有注释
（`src/identity.js` 的模块头与 `buildIdentityHeaders`），此处是面向用户的同一说明。

---

## 已知限制

1. **地区受限模型无法在本机证真**。`muse-spark-1.2/1.3-contributor-free` 在本机出口恒为
   `403 RegionError`（车道处于限流时会先返回 `429`），因此只能验证「归类正确」，无法验证
   「在允许的地区可用」。
2. **responses 协议族无法在本机走通真实链路**。该族只有这两个 muse-spark 模型，全部被地区
   闸门挡住。它的请求编码与事件解析由注入式桩流覆盖（`test/responses.test.js`），
   真实连通性是未验证项。
3. **免费配额仍然存在**。身份伪装只是让请求看起来来自官方客户端，不能创造配额；配额按会话
   池化，用满后会返回 `429 FreeUsageLimitError`（映射为 `RATE_LIMIT`），退避或等窗口恢复。
4. **图片输入按能力表透传，不按 id 猜测**。输入模态取自 `models.dev` 的 `modalities.input`：
   含 `image` 的模型声明 `['text', 'image']`，其余声明 `['text']`。宿主据此决定是否把
   `ImageBlock` 交给适配器；收到图片块的适配器经 attachment 服务取出字节，编码成上游接受的
   形状（chat → `image_url` 的 data URL，responses → `input_image`）。实测
   `nemotron-3.5-super-vl-free` 收图后能正确描述内容。2026-10-17 上游列出的 9 个免费模型中，
   6 个声明了 `image`（`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、
   `longcat-2.5-preview-free`、`mimo-v2.6-flash-free`、`nemotron-3.5-super-vl-free`、
   `space-bunny-free`），2 个仅文本，`jev-1.13-free` 无条目即无图片。
   - 上游另声明了 `video`(11) / `audio`(5) / `pdf`(4)，**不声明**：宿主的 `ModelModalityMap`
     只定义 `text` 与 `image`，且 `ImageBlock` 是唯一的多媒体内容块，文件永远被投影成文本。
     声明宿主没有的类型只会写出非法值。
   - 探测时不要用 1×1 之类退化尺寸的图：上游 vision 预处理会对它返回 `500 Endpoint is
     unavailable`，那是图片无效，不是「模型不支持图片」。
5. **能力元数据运行时拉取，不在仓库里维护快照**。上游清单只给
   `id`/`object`/`created`/`owned_by` 四个字段，不含任何能力信息（`?include=capabilities`
   与 `?include=modalities` 返回逐字节相同的响应，`/models/<id>` 404），因此能力取自
   `models.dev/api.json` 的 `opencode` provider：`limit.context`、`limit.output`、
   `modalities.input` 三项都按 id 透传。进程内缓存，一轮请求只拉一次。
   刻意不声明 `defaultMaxTokens`：它与档位无关，无法表达思考强度差异，请求体的输出预算
   改由档位折算给出（见「思考强度」）。
   - 能力表拉取失败只降级、不致命：目录按纯文本声明输入模态，`context` 省略，日志给出
     `CAPABILITIES_UNAVAILABLE`。
6. **档位 id 不跨 provider 通用，本车道不做别名**。本车道的档位是 `light` / `balanced` / `deep`；
   若把别的 provider 的档位（例如 `high`、`medium`）带给本车道的模型，宿主会在调用适配器**之前**
   抛 `UNSUPPORTED_REASONING_EFFORT`——这是宿主既定行为（不 clamp、不 alias），本插件也不做映射，
   因为档位语义在本车道是「输出预算」，与别的 provider 的强度档没有可溯源的换算关系。
   实务影响：把 profile 的默认模型切到本车道时，若 `agent-default-model` 里还留着别的 provider 的
   `reasoningEffort`，该轮请求会被拒；把该字段改成三个档位之一或删掉即可（删掉则用默认档
   `balanced`）。

---

## 开发

```powershell
npm install          # 只装 devDependency：@deepseek-ai/schemastery
npm test             # node:test，覆盖全部纯逻辑模块与适配器行为
```

`scripts/` 保存**开发期取证与验证脚本**（不参与运行时，也不在 npm `files` 白名单里，因此
不会随包发布）。它们被 `openspec/` 的变更文档引用为「可复现命令」，因此随仓库一起版本化；
每个脚本都用 `import.meta.dirname` 推导路径，在任意 checkout 位置都能直接运行：

```powershell
node scripts/verify-sources.mjs                    # models.dev 实时值 / 归档文档表格 两方对照
node scripts/verify-evidence-matches-script.mjs    # 文档粘贴块与脚本真实 stdout 逐行比对
node scripts/verify-all-models-ladder.mjs          # 全部免费模型逐档核对菜单名称与预算一致
node scripts/verify-catalog-resolve-consistency.mjs # 目录里每个 id 都能解析出合法档位菜单
node scripts/verify-foreign-effort.mjs             # 跨 provider 档位 id 被宿主拒绝、未指定则落默认档
node scripts/e2e-tiers.mjs                         # 档位 → 宿主校验 → 请求体预算 端到端
node scripts/verify-import-regex.mjs               # 依赖检查正则能抓到动态宿主 import
node scripts/count-imports.mjs                     # 说明符计数口径（旧单正则 40 / 新四正则去重 39）
node scripts/mutation-test-import-check.mjs        # 变异测试：证明对抗用例真能抓住正则退化
node scripts/verify-archive-merge.mjs              # 归档后 MODIFIED 头与主规格逐字匹配
node scripts/verify-version.mjs                    # package.json / lock 三处版本一致
```

`scripts/effort.mjs`、`scripts/tiers.mjs`、`scripts/limits.mjs`、`scripts/final-consistency-scan.mjs`
是直连上游/扫描仓库的实测脚本，其中前两个会真实调用 `https://opencode.ai`。
`scripts/probe-image.mjs` 与 `scripts/probe-e2e.mjs` 是图片通路的实测脚本：前者对照两条端点的
收图行为（`PROBE_PNG` 指定 base64 图片），后者端到端验证「能力表透传 + 图片真发 + 模型读出内容」。

模块边界：

| 文件 | 职责 |
|---|---|
| `index.js` | 薄入口：`name` / `inject` / `Config` / `apply` |
| `src/identity.js` | 身份头与版本门槛、会话/请求 id 派生（**含上面那处偏离的注释**） |
| `src/http.js` | 上游请求封装、SSE 解码、错误分类接线 |
| `src/catalog.js` | 清单解析、免费过滤、协议族判定、能力元数据（运行时取自 models.dev） |
| `src/effort.js` | 思考档位阶梯与「档位 → 输出预算」折算（宿主无关纯逻辑） |
| `src/probe.js` | 单模型探测与判定 |
| `src/state.js` | 判定状态机与持久化 |
| `src/schedule.js` | 周期调度与退避 |
| `src/messages.js` | harness 消息 → 两种 wire 请求体（含图片块 → `image_url` / `input_image`） |
| `src/tools.js` | 工具四连补齐与名称回写 |
| `src/chunks.js` | `StreamChunk` 构造、块索引追踪、用量换算 |
| `src/chat.js` | chat 族 SSE → `StreamChunk` |
| `src/responses.js` | responses 族 SSE → `StreamChunk` |
| `src/failure.js` | 失败分类与失败对象构造 |
| `src/adapter.js` | 适配器（`providerInfo`/`providerRetryPolicy`/`imageRequestPricing`/`imageRequestTarget`/`listModels`/`resolveModel`/`prepareCall`），并经 attachment 服务解析图片字节 |
| `src/register.js` | 宿主接线（唯一接触 `@deepseek-ai/*` 的地方） |

除 `src/register.js` 外没有任何模块 import 宿主包，因此全部纯逻辑都能在仓库内直接单测。

## License

MIT
