/**
 * 宿主接线：注册两条 provider 路由、声明配置面、周期刷新模型清单。
 *
 * 这是仓库里**唯一**接触宿主包的地方：它把适配器对象挂到真实的
 * `@deepseek-ai/dsh-llm` 的 `LlmAdapter.prototype` 上，使其成为真正的子类。
 * 该 import 是动态且容错的——宿主包在插件仓库内不可解析（宿主运行时注入），
 * 而本仓库的单元测试要能直接加载 `src/adapter.js`。除此之外，其余模块都不 import
 * 任何 `@deepseek-ai/*` 包。
 *
 * 目录不做探测：免费配额按会话计，周期探测会把自己打到 429（2026-10-18 实测
 * 一轮 9 模型全部 `FreeUsageLimitError`）。轮次只做一件事——拉清单、把免费 id
 * 存进目录；地区分组由配置 `regionModels` 指名。
 *
 * @module src/register.js
 */

import {
  ROUTE_LABELS,
  ROUTES,
  createAdapter,
} from './adapter.js';
import {
  CAPABILITIES_UNAVAILABLE,
  CATALOG_METADATA_UNKNOWN,
  freeCandidates,
  hasTraceableCapabilities,
  loadCapabilities,
  setCapabilityOverrides,
} from './catalog.js';
import { resolveApiKey } from './credentials.js';
import { PROBE_TIMEOUT_MS, fetchModelListing } from './http.js';
import {
  buildIdentityHeaders,
  deriveId,
  probeSession,
  resolveClientVersion,
} from './identity.js';
import { createScheduler } from './schedule.js';
import {
  STATE_VERSION,
  loadState,
  resolveStateFile,
  saveState,
} from './state.js';

/**
 * 把适配器挂到宿主的 `LlmAdapter.prototype` 上。
 *
 * 解析失败（仓库内单测、离线工具）时保持结构等价的普通对象：六个可覆写点我们全部
 * 自己实现，继承本身不带来行为，只带来类型上的从属关系。
 * @param {object} adapter
 */
function adoptHostBaseClass(adapter) {
  void import('@deepseek-ai/dsh-llm')
    .then((module) => {
      const base = module?.LlmAdapter;
      if (typeof base === 'function') Object.setPrototypeOf(adapter, base.prototype);
    })
    .catch(() => {
      // 宿主包不可解析：适配器的六个可覆写点完全由 src/adapter.js 提供，无需基类。
    });
}

/** 把配置里的 regionModels 归一成去重后的 id 数组（非字符串项忽略）。 */
function regionModelIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id === 'string' && id !== '') seen.add(id);
  }
  return [...seen];
}

/**
 * 安装插件。
 * @param {object} ctx cordis 上下文（已 inject `llm`）
 * @param {{probeIntervalMinutes?: number, opencodeVersion?: string, apiKey?: string,
 *          capabilities?: Record<string, object>, regionModels?: string[],
 *          regionRelayUrl?: string, regionRelayToken?: string}} config
 * @param {{pluginName?: string, fetchImpl?: typeof fetch, stateFile?: string}} [options] 测试注入点
 * @returns {object} 供测试与诊断使用的接线句柄
 */
export function register(ctx, config, options = {}) {
  const logger = ctx?.logger ?? console;
  const fetchImpl = options.fetchImpl;
  const pluginName = options.pluginName ?? 'zen-proxy';
  // 周期在每次重新武装时从配置重新求值：运行中改配置能在下一轮生效，无需重启进程。
  const configuredIntervalMs = () => Math.max(1, Number(config?.probeIntervalMinutes) || 10) * 60_000;
  const resolvedVersion = resolveClientVersion(config?.opencodeVersion);
  if (resolvedVersion.usedFallback) {
    logger.warn?.(`zen-proxy: ${resolvedVersion.reason}`);
  }
  const version = resolvedVersion.version;

  // 免费车道闸门已拒绝匿名流量（`Bearer public` 恒 403）：凭据按
  // 配置 apiKey → OPENCODE_API_KEY → opencode 凭据库（opencode.db）→ 旧版 auth.json
  // 的顺序解析。**每轮现解析**（在 runRound 里）：opencode 里换号重登或改配置后
  // 下一轮即生效，无需重启进程。
  const credentials = () => resolveApiKey({ explicit: config?.apiKey });

  // 区域中继（可选）：一个部署在非受限出口的转发 Worker（见 worker/README.md），
  // 让配置指名的地区受限模型恢复可用。URL 不带尾斜杠；令牌经
  // `x-zen-relay-token` 头交给 Worker 校验。
  const relayUrl = typeof config?.regionRelayUrl === 'string' ? config.regionRelayUrl.trim().replace(/\/+$/, '') : '';
  const relayToken = typeof config?.regionRelayToken === 'string' ? config.regionRelayToken.trim() : '';
  const regionRelay = relayUrl !== '' ? { url: relayUrl, token: relayToken } : undefined;
  if (regionRelay !== undefined && relayToken === '') {
    logger.warn?.('zen-proxy: 已配置 regionRelayUrl 但 regionRelayToken 为空；'
      + 'Worker 开启了令牌校验时这些请求会被拒（403）。');
  }
  if (regionModelIds(config?.regionModels).length > 0 && regionRelay === undefined) {
    logger.warn?.('zen-proxy: regionModels 指名了地区受限模型，但未配置 regionRelayUrl；'
      + '这些模型将只能直连（上游会以 RegionError 拒绝当前出口）。');
  }

  // 状态目录由宿主环境解析（DSH_HOME → 宿主配置根），不写死任何用户目录路径。
  // 显式传入的 stateFile 覆盖用给测试，生产路径始终来自环境解析。
  const stateFile = options.stateFile ?? resolveStateFile({ env: process.env });
  let catalog = loadState(stateFile);

  // 宿主的 attachment 服务：图片字节由它按请求尺寸生成。缺失时图片块被丢弃、文本照发。
  const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined;

  const adapter = createAdapter({
    state: () => catalog, clientVersion: version, apiKey: credentials,
    regionModels: () => regionModelIds(config?.regionModels),
    regionRelay, fetchImpl, attachments,
  });
  adoptHostBaseClass(adapter);

  const controller = new AbortController();
  let roundSeed = 0;
  let warnedNoKey = false;

  /**
   * 跑一轮：取清单 → 过滤免费 → 存目录。
   * @returns {Promise<{candidates: string[]}>}
   */
  async function runRound() {
    roundSeed += 1;
    const round = `round-${roundSeed}`;
    const apiKey = await credentials();
    if (apiKey === undefined && !warnedNoKey) {
      warnedNoKey = true;
      logger.warn?.('zen-proxy: 未找到 OpenCode 凭据。免费车道现在必须携带真实凭据：'
        + '在 opencode CLI 登录一次即自动读取（凭据存于 opencode.db，随重登/轮换自动更新），'
        + '或在插件配置 apiKey / 环境变量 OPENCODE_API_KEY 里给出。'
        + '缺失期间清单拉取会以 403 失败，模型目录保持为空。');
    }
    const session = probeSession();
    const requestId = deriveId('msg_', `listing\0${session}\0${round}`);
    const headers = buildIdentityHeaders({ version, session, requestId, stream: false, apiKey });

    let listing;
    try {
      listing = await fetchModelListing({
        headers,
        signal: controller.signal,
        fetchImpl,
        timeoutMs: PROBE_TIMEOUT_MS,
        requestId,
      });
    } catch (error) {
      // 清单拿不到时本轮作废：既有目录保持不动，不因一次拉取失败清空选择器。
      logger.warn?.(`zen-proxy: 模型清单拉取失败，本轮跳过：${error?.message ?? error}`);
      return { candidates: [] };
    }

    // 模型能力（含输入模态）来自 models.dev：模型能力是静态的，拉到什么就透传什么。
    // 失败只影响 inputModalities 的声明，不影响清单与目录。
    if (await loadCapabilities({ fetchImpl, signal: controller.signal }) === undefined) {
      logger.warn?.(`zen-proxy: [${CAPABILITIES_UNAVAILABLE}] 模型能力表拉取失败，`
        + '本轮目录按纯文本声明输入模态');
    }
    // 配置覆盖每轮从 config 现读：改 cordis.patch.yml 的 capabilities 后下一轮生效。
    // 覆盖侧字段赢，models.dev 没有的模型（如 jev-1.13-free）可以只靠覆盖拿全元数据。
    setCapabilityOverrides(config?.capabilities);

    const candidates = freeCandidates(listing);
    const withoutMetadata = candidates.filter((id) => !hasTraceableCapabilities(id));
    if (withoutMetadata.length > 0) {
      logger.warn?.(`zen-proxy: [${CATALOG_METADATA_UNKNOWN}] 以下免费模型没有可溯源的能力元数据，`
        + `将省略 context 字段（不影响它们在目录中的呈现）：${withoutMetadata.join(', ')}`);
    }

    if (controller.signal.aborted) return { candidates };

    catalog = { version: STATE_VERSION, updatedAt: Date.now(), models: candidates };
    saveState(stateFile, catalog);
    const regionCount = regionModelIds(config?.regionModels)
      .filter((id) => candidates.includes(id)).length;
    logger.info?.(`zen-proxy: 清单刷新完成，公告 ${candidates.length} 个免费模型`
      + `（地区分组 ${regionCount} 个按配置指名）`);
    return { candidates };
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? pluginName;
  ctx.llm.registerAdapter([...ROUTES], adapter);
  ctx.llm.registerConfigurableProviders(ROUTES.map((provider) => ({
    provider,
    displayName: ROUTE_LABELS[provider],
    settingsNs,
    // 该车道没有可编辑的连接信息（凭据从配置 / 环境变量 / opencode 凭据库解析，
    // 地址写死在上游常量里）。
    settingsPath: [],
  })));

  const scheduler = createScheduler({
    intervalMs: configuredIntervalMs,
    run: runRound,
    onError: (error) => logger.warn?.(`zen-proxy: 清单刷新轮次异常：${error?.message ?? error}`),
  });

  // 注册本身随 fiber 自动释放（宿主的 `registerAdapter` / `registerConfigurableProviders`
  // 都把释放挂在各自的 effect 上），因此这里只需要管好刷新循环的生命周期。
  ctx.effect(() => {
    scheduler.start();
    return () => {
      scheduler.stop();
      controller.abort();
    };
  }, 'zen-proxy: listing loop');

  if (catalog.models.length === 0) {
    logger.info?.('zen-proxy: 本地没有历史清单，目录将在首轮拉取完成后填充');
  }

  return { adapter, scheduler, runRound, stateFile, routes: [...ROUTES] };
}
