/**
 * 宿主接线：注册两条 provider 路由、声明配置面、跑周期探测。
 *
 * 这是仓库里**唯一**接触宿主包的地方：它把适配器对象挂到真实的
 * `@deepseek-ai/dsh-llm` 的 `LlmAdapter.prototype` 上，使其成为真正的子类。
 * 该 import 是动态且容错的——宿主包在插件仓库内不可解析（宿主运行时注入），
 * 而本仓库的单元测试要能直接加载 `src/adapter.js`。除此之外，其余模块都不 import
 * 任何 `@deepseek-ai/*` 包。
 *
 * @module src/register.js
 */

import {
  ROUTE_LABELS,
  ROUTES,
  createAdapter,
} from './adapter.js';
import {
  CATALOG_METADATA_UNKNOWN,
  freeCandidates,
  hasTraceableCapabilities,
} from './catalog.js';
import { resolveApiKey } from './credentials.js';
import { FAILURE_CODE, FAILURE_SCOPE } from './failure.js';
import { PROBE_TIMEOUT_MS, fetchModelListing } from './http.js';
import {
  buildIdentityHeaders,
  deriveId,
  probeSession,
  resolveClientVersion,
} from './identity.js';
import { PROBE_STATE, probeModels } from './probe.js';
import { createScheduler } from './schedule.js';
import {
  MODEL_STATE,
  loadState,
  modelsWithVerdict,
  reduceRound,
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

/**
 * 安装插件。
 * @param {object} ctx cordis 上下文（已 inject `llm`）
 * @param {{probeIntervalMinutes?: number, opencodeVersion?: string, apiKey?: string}} config
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
  // 配置 apiKey → OPENCODE_API_KEY → opencode auth.json 的顺序解析，解析一次全程复用。
  const apiKey = resolveApiKey({ explicit: config?.apiKey });
  if (apiKey === undefined) {
    logger.warn?.('zen-proxy: 未找到 OpenCode API key。免费车道现在必须携带真实凭据：'
      + '登录一次 opencode CLI（`opencode auth login`）后自动读取，'
      + '或在插件配置 apiKey / 环境变量 OPENCODE_API_KEY 里给出。'
      + '缺失期间探测会以 403 FreeTierError 失败，模型目录保持为空。');
  }

  // 区域中继（可选）：一个部署在非受限出口的转发 Worker（见 worker/README.md），
  // 让地区受限模型（RegionError）恢复可用。URL 不带尾斜杠；令牌经
  // `x-zen-relay-token` 头交给 Worker 校验。
  const relayUrl = typeof config?.regionRelayUrl === 'string' ? config.regionRelayUrl.trim().replace(/\/+$/, '') : '';
  const relayToken = typeof config?.regionRelayToken === 'string' ? config.regionRelayToken.trim() : '';
  const regionRelay = relayUrl !== '' ? { url: relayUrl, token: relayToken } : undefined;
  if (regionRelay !== undefined && relayToken === '') {
    logger.warn?.('zen-proxy: 已配置 regionRelayUrl 但 regionRelayToken 为空；'
      + 'Worker 开启了令牌校验时这些请求会被拒（403）。');
  }
  const relayProbeHeaders = relayToken !== '' ? { 'x-zen-relay-token': relayToken } : undefined;

  // 状态目录由宿主环境解析（DSH_HOME → 宿主配置根），不写死任何用户目录路径。
  // 显式传入的 stateFile 覆盖用给测试，生产路径始终来自环境解析。
  const stateFile = options.stateFile ?? resolveStateFile({ env: process.env });
  let state = loadState(stateFile);

  const adapter = createAdapter({ state: () => state, clientVersion: version, apiKey, regionRelay, fetchImpl });
  adoptHostBaseClass(adapter);

  const controller = new AbortController();
  let roundSeed = 0;

  function logDiagnostics(diagnostics) {
    for (const entry of diagnostics) {
      logger.warn?.(`zen-proxy: [${entry.code}] ${entry.message}`);
    }
  }

  /**
   * 跑一轮：取清单 → 过滤免费 → 探测 → 折算状态 → 持久化。
   * @returns {Promise<{throttled: boolean, candidates: string[]}>}
   */
  async function runRound() {
    roundSeed += 1;
    const round = `round-${roundSeed}`;
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
      logger.warn?.(`zen-proxy: 模型清单拉取失败，本轮探测跳过：${error?.message ?? error}`);
      return { throttled: false, candidates: [] };
    }

    const candidates = freeCandidates(listing);
    const withoutMetadata = candidates.filter((id) => !hasTraceableCapabilities(id));
    if (withoutMetadata.length > 0) {
      logger.warn?.(`zen-proxy: [${CATALOG_METADATA_UNKNOWN}] 以下免费模型没有可溯源的能力元数据，`
        + `将省略 context 字段（不影响它们在目录中的呈现）：${withoutMetadata.join(', ')}`);
    }

    // 探测分组：直连为主；已判定「地区受限」的模型在配置了中继时改走中继探测，
    // 中继探测判定可用即恢复进主目录（状态记 via: 'relay'，对话请求同路）。
    const relaySet = regionRelay !== undefined
      ? new Set(modelsWithVerdict(state, MODEL_STATE.region).filter((id) => candidates.includes(id)))
      : new Set();
    const directSet = candidates.filter((id) => !relaySet.has(id));

    const results = await probeModels(
      directSet,
      { round, version, apiKey, signal: controller.signal, fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
      (modelId, result) => {
        logger.info?.(`zen-proxy: 探测 ${modelId} → ${result.state}`);
      },
    );
    if (relaySet.size > 0) {
      const relayResults = await probeModels(
        [...relaySet],
        {
          round, version, apiKey, baseUrl: regionRelay.url, extraHeaders: relayProbeHeaders,
          signal: controller.signal, fetchImpl, timeoutMs: PROBE_TIMEOUT_MS,
        },
        (modelId, result) => {
          logger.info?.(`zen-proxy: 探测 ${modelId}（经区域中继）→ ${result.state}`);
        },
      );
      for (const [id, result] of Object.entries(relayResults)) {
        results[id] = { ...result, via: 'relay' };
      }
    }

    if (controller.signal.aborted) return { throttled: false, candidates };

    // 插件级失败（身份／版本被拒）与具体模型无关：整条车道降级。
    const pluginFailure = candidates
      .map((id) => results[id])
      .find((result) => result?.state === PROBE_STATE.unknown && result.failure?.scope === FAILURE_SCOPE.plugin);

    const { state: next, diagnostics } = reduceRound(state, {
      models: candidates,
      results,
      pluginFailure: pluginFailure?.failure ?? null,
    });
    logDiagnostics(diagnostics);
    state = next;
    saveState(stateFile, next);
    logger.info?.(`zen-proxy: 一轮探测完成，公告 ${modelsWithVerdict(next, 'available').length} 个可用、`
      + `${modelsWithVerdict(next, 'region').length} 个地区受限`);

    const throttled = candidates.length > 0
      && candidates.every((id) => {
        const result = results[id];
        if (result?.state !== PROBE_STATE.transient) return false;
        const code = result.failure?.code;
        return code === FAILURE_CODE.rateLimit || code === FAILURE_CODE.quota;
      });
    return { throttled, candidates };
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? pluginName;
  ctx.llm.registerAdapter([...ROUTES], adapter);
  ctx.llm.registerConfigurableProviders(ROUTES.map((provider) => ({
    provider,
    displayName: ROUTE_LABELS[provider],
    settingsNs,
    // 该车道没有可编辑的连接信息（凭据从配置 / 环境变量 / opencode auth.json 解析，
    // 地址写死在上游常量里）。
    settingsPath: [],
  })));

  const scheduler = createScheduler({
    intervalMs: configuredIntervalMs,
    run: runRound,
    onError: (error) => logger.warn?.(`zen-proxy: 探测轮次异常：${error?.message ?? error}`),
  });

  // 注册本身随 fiber 自动释放（宿主的 `registerAdapter` / `registerConfigurableProviders`
  // 都把释放挂在各自的 effect 上），因此这里只需要管好探测循环的生命周期。
  ctx.effect(() => {
    scheduler.start();
    return () => {
      scheduler.stop();
      controller.abort();
    };
  }, 'zen-proxy: probe loop');

  if (Object.keys(state.models).length === 0) {
    logger.info?.('zen-proxy: 本地没有历史探测结果，目录将在首轮探测完成后填充');
  }

  return { adapter, scheduler, runRound, stateFile, routes: [...ROUTES] };
}
