/**
 * 上游模型清单的解析、免费过滤、协议族判定与能力元数据。
 *
 * 实测 `GET https://opencode.ai/zen/v1/models`（200，`application/json`，7232 字节）：
 *
 * ```json
 * {"object":"list","data":[{"id":"claude-fable-5","object":"model","created":1791377709,"owned_by":"opencode"}]}
 * ```
 *
 * 清单里**只有** 4 个字段：`id`、`object`（恒为 `"model"`）、`created`、`owned_by`
 * （恒为 `"opencode"`）。没有表示「免费」的字段，没有表示「协议族」的字段，
 * 也没有上下文窗口、输出上限或输入模态。详情端点也不存在：`/zen/v1/models/<id>` 返回
 * 404（HTML），`?include=capabilities` 与 `?include=modalities` 返回**与基准逐字节
 * 相同**的响应。因此：
 *
 * - 免费判定 = id 以 `-free` 结尾（spec 的「目录只公布免费且可用的模型」定义）；
 * - 协议族判定 = 按 id 决定端点（design D11）；
 * - 上下文窗口 / 输出上限 / 输入模态 = 取自 {@link CAPABILITIES_URL} 并按 id 透传。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/catalog.js
 */

/** 唯一允许写死的网络地址：上游 base URL。 */
export const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

export const MODELS_PATH = '/models';
export const CHAT_COMPLETIONS_PATH = '/chat/completions';
export const RESPONSES_PATH = '/responses';

/** 免费车道的 id 后缀。 */
export const FREE_SUFFIX = '-free';

/** 能力表里没有可溯源窗口的模型的诊断码。 */
export const CATALOG_METADATA_UNKNOWN = 'CATALOG_METADATA_UNKNOWN';

/**
 * 文本模型的目录元数据（上下文窗口 / 输出上限）来源。
 *
 * 与 {@link CAPABILITIES_URL} 同一份清单：`models.dev` 的 `opencode` provider 对全部
 * 免费模型都给出 `limit.context` 与 `limit.output`（2026-10-17 实测 42/42，一个不缺）。
 * 因此不再维护静态快照，运行时按 id 直接透传上游公布的值。
 */
/**
 * responses 协议族的 id 模式。
 *
 * 上游清单不披露协议族（实测每项只有 `id`/`object`/`created`/`owned_by`），因此只能按 id
 * 判定（design D11 授权）。本模式的依据是**间接**的，且在本机出口（CN）无法证真：
 *
 * - 这两个 id 发到 `/responses` 得到 403 `RegionError`；
 * - 但它们发到 `/chat/completions` **同样**返回 403 `RegionError`——地区闸门先于路由判定，
 *   所以这条**不能**证明「该端点接受这个 id」；
 * - chat 族模型发到 `/responses` 得到 `500 server_error`，既可能是该端点不接受这个 id，
 *   也可能是无关的上游故障；
 * - 社区同类实现收敛到**逐字相同**的模式：`dsh-our-free-model` 的 `isMuseSpark`
 *   （`upstream.js:104-108`）用 `/^muse[-_]?spark(?:$|[-_:.\s])/i`，与本模块
 *   `RESPONSES_ID_PATTERN`（同文件下方常量）逐字相同，并经 `isResponsesModel`
 *   → `endpointFor` 驱动端点选择（`upstream.js:110-123`）。两个独立实现从同一上游行为
 *   收敛出同一正则，是这条间接判据最实的支撑。
 *
 * 猜错的代价有限：只影响这一个 id 走哪个端点，不影响其它模型；而在本机这些 id 恒被地区闸门
 * 拦住，真实链路无从区分。详见 evidence.md 的「协议族的判据（间接；本机无法证真）」。
 */
const RESPONSES_ID_PATTERN = /^muse[-_]?spark(?:$|[-_:.\s])/i;

/**
 * 解析清单响应体为 id 列表（去重、保持上游顺序）。
 * @param {unknown} payload
 * @returns {string[]}
 */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

/**
 * 免费车道判定：id 以 `-free` 结尾。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isFreeModel(modelId) {
  return typeof modelId === 'string' && modelId.endsWith(FREE_SUFFIX) && modelId.length > FREE_SUFFIX.length;
}

/**
 * 从清单响应体里取出候选免费模型 id。
 * @param {unknown} payload
 * @returns {string[]}
 */
export function freeCandidates(payload) {
  return parseListing(payload).filter(isFreeModel);
}

/**
 * 去掉 id 上的模型级后缀，得到用于模式匹配的基名。
 * @param {unknown} modelId
 * @returns {string}
 */
export function baseModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const withoutSuffix = raw.replace(/\([^()]*\)\s*$/, '').trim();
  return withoutSuffix.includes('/') ? withoutSuffix.split('/').pop() : withoutSuffix;
}

/**
 * 该模型是否由 responses 协议族提供。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isResponsesModel(modelId) {
  return RESPONSES_ID_PATTERN.test(baseModelId(modelId));
}

/**
 * 该模型走哪个协议族。
 * @param {unknown} modelId
 * @returns {'chat' | 'responses'}
 */
export function wireFor(modelId) {
  return isResponsesModel(modelId) ? 'responses' : 'chat';
}

/**
 * 协议族对应的上游路径。
 * @param {'chat' | 'responses'} wire
 * @returns {string}
 */
export function pathForWire(wire) {
  return wire === 'responses' ? RESPONSES_PATH : CHAT_COMPLETIONS_PATH;
}

/**
 * 模型的上游端点路径。
 * @param {unknown} modelId
 * @returns {string}
 */
export function pathForModel(modelId) {
  return pathForWire(wireFor(modelId));
}

/**
 * 该模型的上下文窗口（tokens）。能力表里没有时返回 `undefined`。
 * @param {unknown} modelId
 * @returns {number | undefined}
 */
export function contextWindowFor(modelId) {
  const value = capabilityOf(modelId)?.limit?.context;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 该模型的输出上限（tokens）。能力表里没有时返回 `undefined`。
 * @param {unknown} modelId
 * @returns {number | undefined}
 */
export function outputLimitFor(modelId) {
  const value = capabilityOf(modelId)?.limit?.output;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 模型能力的来源：`https://models.dev/api.json` 的 `opencode` provider。
 *
 * 上游清单（`GET /zen/v1/models`）只给 `id`/`object`/`created`/`owned_by` 四个字段，
 * 不含任何能力信息（`?include=capabilities` 返回逐字节相同的响应，`/models/<id>` 404）。
 * 因此模态取自 models.dev —— 与上下文窗口同源，但改为**运行时拉取**：
 * 模型能力是静态的，拉到什么就透传什么，不在仓库里维护快照。
 */
export const CAPABILITIES_URL = 'https://models.dev/api.json';

/** 拉取失败时的诊断码。 */
export const CAPABILITIES_UNAVAILABLE = 'CAPABILITIES_UNAVAILABLE';

/** 进程内缓存：清单很大（约 5.8MB），一轮只取一次。 */
let capabilitiesCache;

/**
 * 拉取并缓存 models.dev 的 opencode 模型能力表。
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, object> | undefined>} 解析失败或网络失败时返回 `undefined`
 */
export async function loadCapabilities({ fetchImpl = fetch, signal } = {}) {
  if (capabilitiesCache !== undefined) return capabilitiesCache;
  try {
    const res = await fetchImpl(CAPABILITIES_URL, { signal });
    if (!res.ok) return undefined;
    const data = await res.json();
    capabilitiesCache = (data?.opencode ?? data?.providers?.opencode)?.models ?? {};
    return capabilitiesCache;
  } catch {
    return undefined;
  }
}

/**
 * 清空能力缓存（测试与诊断用）。
 */
export function resetCapabilities() {
  capabilitiesCache = undefined;
}

/**
 * 取某个模型在 models.dev 里的条目。
 * @param {unknown} modelId
 * @returns {object | undefined}
 */
export function capabilityOf(modelId) {
  const base = baseModelId(modelId);
  return capabilitiesCache?.[base];
}

/**
 * 由 models.dev 条目解析输入模态：`modalities.input` 里有 `image` 就带上。
 *
 * 只输出宿主认识的两种值（`text` / `image`）；上游另有的 `video`/`audio`/`pdf` 不在
 * 宿主的模态词汇表里，忽略。没有条目时回退 `['text']`。
 *
 * @param {unknown} modelId
 * @returns {readonly ('text' | 'image')[]}
 */
export function inputModalitiesFor(modelId) {
  return capabilityOf(modelId)?.modalities?.input?.includes('image') === true
    ? ['text', 'image']
    : ['text'];
}

/**
 * 该模型是否接受图片输入。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function acceptsImage(modelId) {
  return capabilityOf(modelId)?.modalities?.input?.includes('image') === true;
}

/**
 * 该模型在能力表里是否有条目。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function hasTraceableCapabilities(modelId) {
  return capabilityOf(modelId) !== undefined;
}

/**
 * 把上游 id 渲染成可供模型选择器展示的名字。
 * @param {unknown} modelId
 * @returns {string}
 */
export function displayNameFor(modelId) {
  const base = baseModelId(modelId);
  if (base === '') return String(modelId ?? '');
  return base
    // 只把 `-` 与 `_` 当词分隔符：`.` 是版本号的一部分（`3.5` 不能被拆成 `3 5`）。
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}
