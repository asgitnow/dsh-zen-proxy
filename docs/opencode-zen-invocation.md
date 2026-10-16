# OpenCode Zen 免费车道调用规格

> 状态：**权威**（2026-10-15 实测定稿）。本文件描述 dsh-zen-proxy 调用 OpenCode Zen
> 免费车道（`https://opencode.ai/zen/v1`）的完整线上契约，含当前闸门的全部校验规则、
> 判定语义与配额行为。
>
> 证据方法：以 opencode 2.0.24 客户端源码（`anomalyco/opencode`）与真实请求字节捕获为
> 基线，对每个字段做**单变量隔离实测**；所有结论标注实测日期。本文件取代
> `openspec/specs/zen-free-upstream-wire` 中与本文冲突的条目（该 spec 记录的是 8 月版
> 闸门：六头、`Bearer public`、`tool_choice: none`、工具四连齐备——现均已失效或放宽）。
>
> 闸门会继续演化。任何与本文不符的观测都应先怀疑上游变更，再以单变量法重测并更新本文。

---

## 1. 端点与协议族

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 模型清单 | `GET /zen/v1/models` | **不受闸门约束**，匿名可读；清单项只有 `id` / `object` / `created` / `owned_by`，**没有免费标记字段** |
| chat 族对话 | `POST /zen/v1/chat/completions` | OpenAI chat completions 形状 |
| responses 族对话 | `POST /zen/v1/responses` | OpenAI responses 形状，请求体须带 `store: false` |

协议族按模型判定（`src/catalog.js` 的 `wireFor`）：muse-spark 系等走 responses 族，
其余走 chat 族。两个族的探测与对话都受同一套闸门约束。

免费模型判据：模型 id 以 `-free` 结尾。付费模型不出现在免费车道。

---

## 2. 请求身份

### 2.1 凭据（必须）

匿名车道**已关闭**：`Authorization: Bearer public` 恒定返回
`403 FreeTierError`。每个请求必须携带真实 API key：

```
authorization: Bearer <OPENCODE_API_KEY>
```

key 来源（`src/credentials.js`，按序解析）：插件配置 `apiKey` → 环境变量
`OPENCODE_API_KEY` → opencode 客户端凭据 `~/.local/share/opencode/auth.json` 的
`opencode.key`（登录过 `opencode auth login` 即有）。

> 实测（2026-10-15）：同一组头，`Bearer public` → 403 FreeTierError；真实 key → 过。
> key 错误时表现与匿名一致（后端不区分）。

### 2.2 会话 id：官方算法（必须）

session id 必须按 opencode 官方 `Identifier.create(true)` 算法生成
（`src/identity.js` 的 `createSessionId`）：

```
ses_ + hex( (~(时间戳ms * 0x1000 + 计数器)) 低 48 位, 6 字节 ) + base62( 14 个随机字符 )
```

- 前 12 个 hex 字符编码创建时间（时间降序），后 14 位 base62 随机；
- **时间戳部分随机**（如 sha256 派生）的 session 一律 `403 FreeTierError`；
- 会话年龄不敏感：30 天前与未来 1 小时的会话均实测放行；
- 形状正则：`/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`。

### 2.3 请求头集合

session id 必须同时出现在**四个**头里（与真实客户端一致）：

| 头 | 值 | 校验 |
|---|---|---|
| `x-opencode-session` | session id | **必须** |
| `x-opencode-session-id` | session id（无父会话时同值） | **必须** |
| `x-session-affinity` | session id | **必须** |
| `x-session-id` | session id | **必须** |
| `authorization` | `Bearer <key>` | **必须**（见 2.1） |
| `content-type` | `application/json` | 必须 |
| `accept` | `text/event-stream` 或 `*/*` | 不校验 |
| `user-agent` | `opencode/<channel>/<version>/<name>`（如 `opencode/latest/2.0.24/cli`） | **不校验**（两段式旧 UA、伪造版本均放行；建议保持四段式以贴近真实指纹） |
| `x-opencode-client` | `cli` / `desktop` | 不校验 |
| `x-opencode-project` | 任意值（真实客户端发 40 位项目哈希） | 不校验 |
| `x-opencode-org-id` | 账号组织 id | 不校验（省略亦可） |
| `b3` / `traceparent` | W3C 追踪上下文 | 不校验（真实客户端发，插件可不发） |

实测只发 `x-opencode-session` 一个（缺另外三个）会被拒——**四个头缺一不可**。

### 2.4 禁止项（违反即 `403 FreeTierError`）

| 禁止 | 说明 |
|---|---|
| `x-opencode-request` 头 | **真实客户端不发它**。带上即被拒（Console 的 Worker 会把它转发为 `x-opencode-request-id`，后端对带此头的请求拒绝）。本地仍可生成请求 id 用于错误分类，只是**不上线** |
| 匿名 `Bearer public` | 见 2.1 |
| 随机时间戳的 session | 见 2.2 |

### 2.5 头集合小结（发出去的完整集合）

```
authorization: Bearer <key>
content-type: application/json
user-agent: opencode/latest/<version>/cli
x-opencode-client: cli
x-opencode-project: global
x-opencode-session: <ses>
x-opencode-session-id: <ses>
x-session-affinity: <ses>
x-session-id: <ses>
accept: text/event-stream        （对话）；*/*（清单）
```

实现入口：`buildIdentityHeaders`（`src/identity.js`）——它是构造上游请求头的唯一入口。

---

## 3. 请求体

### 3.1 工具数组（必须满足全部三条）

1. **canary**：数组中必须存在一个名为 `read` 的工具（真实客户端永远携带；实测
   `shell` / `edit` / `glob` / `grep` / `write` / `webfetch` 单独在都不过，改名的
   `read` 也不过）；
2. **每个工具**的 `parameters.properties` 必须非空——空 properties 的工具（含 canary
   自己）使整个请求 `403 FreeTierError`；
3. 工具名不限于官方集合：调用方自有名字（`task`、`todowrite`、`pwsh`…）可原样直传；
   描述文案完全不敏感（可写 "unavailable" 提示）。

插件的补齐策略（`src/tools.js`）：调用方工具优先占用 `bash`/`glob`/`grep`/`read` 四个
槽位（Windows 上宿主的 `pwsh` 改名填 `bash` 槽），缺失槽位补**官方真实参数 schema 的
自禁用占位工具**；响应侧按映射把改写名还原（`restoreToolName`）。

### 3.2 `tool_choice`：禁止发送

上游只接受 `"auto"`：`"none"`、`"required"`、指定函数名均被拒
（`400 only "auto" is supported for tool_choice`）。探测与对话**一律不发送该字段**
（缺省即 auto 语义）。2026-10-15 在 muse-spark 系上暴露——此前被地区闸门掩盖。

### 3.3 其余字段

| 字段 | 要求 |
|---|---|
| `stream` | 必须 `true`（两族都是） |
| `max_tokens`（chat）/ `max_output_tokens`（responses） | 均接受，无下限校验（探测发 16） |
| `stream_options` | 可选，发不发都行 |
| `messages` | 形状按协议族；system 有无不敏感 |
| `store` | responses 族必须 `false`（插件恒发） |

---

## 4. 响应与判定

### 4.1 HTTP 200 ≠ 可用

闸门会在 2xx 的流里塞错误对象。判定**必须解析数据帧**（`src/probe.js`）：

- 非 2xx → 按错误信封的 `type` 与状态码分类；
- 2xx → 逐帧解析：出现 `{"error": …}` 即判失败；出现正常流式增量才判可用
  （chat 族：`choices[0].delta` 对象；responses 族：`response.output_text.delta`
  等事件名）；
- 只看状态码会把「200 + 流内错误」误判为可用。

### 4.2 失败分类（`src/failure.js`）

实测信封（全部来自真实上游）：

| 响应 | 分类 | 范围 | 性质 |
|---|---|---|---|
| `403 RegionError`（"not available in your country"） | AUTH + region 标记 | 模型 | 终局（地区受限） |
| `403 FreeTierError` / `426 UpgradeRequired` / `SubscriptionError` | AUTH | **插件级**（整条车道降级，全部模型转 unknown） | 终局 |
| `401 ModelError`（指名模型不可路由） | AUTH | 模型 | 终局 |
| `429 FreeUsageLimitError` / `RateLimitError` / `rate_limit` | RATE_LIMIT | 模型 | 瞬时 |
| 429 + quota/balance/credit 措辞（`insufficient_quota` 等） | QUOTA | 模型 | 瞬时 |
| `5xx`、信封 `type: server_error` / `api_error` / `overloaded_error` | SERVER | 模型 | 瞬时 |
| 网络失败 / 超时 | TRANSPORT / TIMEOUT | 模型 | 瞬时 |

### 4.3 瞬时故障宽限与全轮退避

- 瞬时故障**连续 3 次以内保留前值**（一次抖动不把模型从目录抹掉），第 3 次转
  `unavailable`；
- 一整轮全部限流 → 下轮探测间隔指数退避（上限 1 小时），出现可用模型即恢复周期；
- 最近一次判定持久化（`$DSH_HOME/zen-proxy/availability.json`，先写临时文件再原子
  改名），重启后目录立即反映上次已知状态。

---

## 5. 配额与限流语义（实测）

- **免费配额按 session 计**：逐请求新造会话会迅速打满配额。对话会话按对话标识稳定
  派生（同一对话重启后仍是同一会话，`src/identity.js` 的 `sessionForConversation`）；
- **配额池按模型划分**：同一出口 IP 上不同模型的余量互不相同（实测同 IP 同时刻，
  cat-jam 可用而 mimo/muse-spark 被限流）；
- **限流发生在地区判定之前**：车道限流期间，地区受限模型返回 `429 FreeUsageLimitError`
  而非 `RegionError`——「地区受限」只能在车道不限流时观察到；
- **探测流量与对话配额隔离**：探测每模型每轮用独立的新会话（时间戳真实即合法），
  与用户对话会话互不挤占；
- **出口 IP 参与限流记账**：同一 VPS IP 高频探测后部分模型池持续 429（2026-10-15 实测，
  本机直连正常而 VPS 出口 429）。解法见 §6 的 WARP 出口。

---

## 6. 地区闸门与出口（中继）

`403 RegionError`（"This model is not available in your country"）按**请求出口 IP 的
国家**判定，与账号、请求头、模型配额无关。实测（2026-10-15）：

| 出口 | muse-spark 系结果 |
|---|---|
| 本机 CN 直连 | `RegionError` |
| Cloudflare Worker（边缘出口 HKG/SJC） | 仍 `RegionError` —— **Worker 方案不可行**：Worker 的出站子请求从 CF 边缘机房发出，仍属亚太出口，且 worker→worker 的子请求不改变地区判定 |
| 美国 VPS 直连出口（San Jose） | `available` |
| 美国 VPS 经 Cloudflare CDN 回源 | `available`（CDN 只承载客户端→中继一跳，出口由中继决定） |

**结论**：出口必须是真正的非受限地区 IP。落地形态（`worker/` 目录与 VPS 部署同构）：

```
dsh → https://code.softx.eu.org:8443 (Cloudflare CDN，入口)
    → 美国源站中继（令牌鉴权，仅放行 /models、/chat/completions、/responses）
    → https://opencode.ai/zen/v1 (从美国出口发出)
```

- 中继做**纯透传**：令牌鉴权（`x-zen-relay-token`，常数时间比较，未配置即 fail
  closed）+ 方法/路径/头/体/SSE 原样转发，不持有任何 opencode 凭据；
- 插件侧配置 `regionRelayUrl` / `regionRelayToken` 后，上一轮判定为地区受限的模型改经
  中继探测，判定可用即记 `via: "relay"` 进主目录，对话请求同走中继；
- 中继上的限流与直连出口独立记账；源站出口 IP 被「打脏」时，给源站配 Cloudflare WARP
  出口可换得干净 IP（注意 WARP 全局模式会劫持入站 SSH 的回包路由——应只对出站做策略
  路由，或接受带外管理）；
- VPS 源站 TLS 用 Cloudflare Origin Certificate（对 CF→源站校验有效，15 年免续签）。

---

## 7. 会话管理规则汇总（`src/identity.js`）

| 流量 | 会话策略 |
|---|---|
| 用户对话 | 按对话标识注册表派生，进程内稳定复用（配额按 session 计） |
| 一轮对话的一次尝试 | 请求 id 由「会话 + 轮次」派生（`requestForTurn`），同轮多次尝试共享请求身份 |
| 探测 | 每模型每轮一个新会话（摊薄探测配额），请求 id 绑定「会话 + 轮次 + 模型」 |
| 模型清单 | 无会话要求（端点不设闸），仍携带完整身份头 |

---

## 8. 实现映射

| 规格 | 实现 |
|---|---|
| §2.1 凭据解析 | `src/credentials.js` |
| §2.2 会话算法 / §2.3 头集合 / §2.4 禁止项 | `src/identity.js`（`createSessionId` / `buildIdentityHeaders`） |
| §3.1 工具 canary 与占位 | `src/tools.js`（`applyToolQuartet` / `restoreToolName`） |
| §3.2 tool_choice 禁发 / §3.3 请求体 | `src/messages.js`（`buildRequestFor`）+ `src/probe.js`（`probeRequestFor`） |
| §4.1 帧判定 | `src/probe.js`（`isNormalIncrement`）+ `src/chunks.js` |
| §4.2 失败分类 | `src/failure.js` |
| §4.3 宽限与退避 / 持久化 | `src/state.js` + `src/schedule.js` |
| §5 会话策略 | `src/identity.js`（`sessionForConversation` / `probeSession`） |
| §6 中继 | `src/adapter.js`（via 路由）+ `src/register.js`（探测分组）+ `worker/relay.js` |

## 附录：单变量实测记录（2026-10-15）

以字节级捕获的真实客户端请求为基线，每次只改一个变量打真实闸门：

| 变量 | 结果 |
|---|---|
| 原样重放 | 200 ✅ |
| 换新 trace id | 200 ✅（不校验） |
| 换新 project / 去 org-id | 200 ✅（不校验） |
| 换随机 session | 403 ❌ → 定位时间戳校验 |
| 换官方算法新 session | 200 ✅ → 算法即为合法性 |
| session 只出现在 1 个头 | 403 ❌ → 四头缺一不可 |
| 带 `x-opencode-request` | 403 ❌ → 禁止项 |
| 换 `Bearer public` | 403 ❌ → 匿名关闭 |
| tools 空数组 / 无 read / 空 properties | 403 ❌ → §3.1 三条规则 |
| `tool_choice: none` | 400 ❌ → 只接受 auto |
| `opencode/1.18.31` 旧 UA、伪造版本号 | 200 ✅ → UA 不校验 |
