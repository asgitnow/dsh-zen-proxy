# zen-region-relay — 区域受限模型中继

把 dsh-zen-proxy 的免费车道请求从**非受限出口**转发给 opencode.ai，让被出口国家拦截的
模型（`403 RegionError`，如 `muse-spark-*-contributor-free`）恢复可用。SSE 流式响应逐字节
透传；转发前用部署侧令牌校验调用方，避免成为裸奔代理。

原理：Cloudflare Worker 的出站请求从 CF 边缘机房发出（非受限地区的 IP），上游的区域
闸门看的是这个出口 IP，于是判定放行。插件的免费凭据与身份头原样经过 Worker 转发，
Worker 自身不持有任何 opencode 凭据。

## 部署（一次性，约 3 分钟）

```sh
cd worker
npm install -g wrangler     # 或 npx wrangler
wrangler login              # 浏览器登录 Cloudflare 账号

# 设置访问令牌（自己生成一个长随机串；插件侧要填同一个值）
wrangler secret put RELAY_TOKEN
# 出现提示时粘贴令牌，例如：openssl rand -hex 24 的输出

wrangler deploy
```

部署成功会输出 Worker 地址，形如
`https://zen-region-relay.<你的子域>.workers.dev`。

## 在 dsh-zen-proxy 里启用

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，给 `zen-proxy` 条目加配置覆盖：

```yaml
- id: zen-proxy
  config:
    regionRelayUrl: https://zen-region-relay.<你的子域>.workers.dev
    regionRelayToken: <与 RELAY_TOKEN 相同的令牌>
```

（若已有 `zen-proxy` 的 `config` 覆盖块，把两个字段并进去即可。）重启 dsh 生效。

## 生效后的行为

- 每轮探测里，此前判定为「地区受限」的模型改经中继探测；
- 中继探测判定**可用** → 模型进入主分组「OpenCode Zen 免费模型」，对话请求同走中继
  （状态记 `via: "relay"`）；
- 中继探测仍返回 `RegionError`（例如 Worker 出口仍被上游限制）→ 模型留在地区分组；
- 中继故障（不可达 / 令牌错误）按瞬时故障处理，有宽限，不会清空目录；
- 卸载配置（删掉两个字段）后自动回退直连探测。

## 代价与限制

- Worker 免费额度：每天 10 万次请求；插件的探测与对话都算，正常个人使用远够。
- 延迟略增（多一跳 CF 边缘）；流式响应不受影响。
- 令牌泄露 = 别人能用你的 Worker 消耗你的免费配额；泄露后
  `wrangler secret put RELAY_TOKEN` 换新并同步改插件配置。
- 未验证项：上游区域闸门对 CF 边缘出口的实际放行情况无法在本机（受限出口）预验证，
  以部署后第一轮探测的日志为准（`探测 <model>（经区域中继）→ available` 即成功）。
