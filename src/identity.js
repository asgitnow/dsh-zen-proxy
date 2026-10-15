/**
 * 上游身份：伪装成官方 OpenCode 客户端的请求头、版本门槛，以及会话 id 的派生。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包，也不发起 I/O
 * （凭据解析在 `src/credentials.js`）。
 *
 * ## 2026-10 闸门变更（实测，本机出口 CN）
 *
 * 旧实现（8 月）的六个身份头已不足以上过免费车道闸门。当前实测规则：
 *
 * 1. **session id 必须按官方算法生成**：`ses_` + 6 字节倒序时间戳（hex）+ 14 位
 *    base62 随机。时间戳部分随机（如 sha256 派生）的 session 一律
 *    `403 FreeTierError`。会话年龄不敏感（30 天前与未来 1 小时均放过）。
 * 2. **工具数组必须包含一个名为 `read` 的工具，且每个工具的
 *    `parameters.properties` 非空**（见 `src/tools.js`）。
 * 3. **匿名车道已关闭**：`Bearer public` 恒定 403，必须使用真实 API key
 *    （`OPENCODE_API_KEY` 或 opencode 客户端的 `auth.json`，见 `src/credentials.js`）。
 * 4. **session 必须出现在四个头里**：`x-opencode-session` / `x-opencode-session-id` /
 *    `x-session-affinity` / `x-session-id`（只发第一个会被拒）。
 * 5. **禁止携带 `x-opencode-request`**：真实客户端不发它；带上即被
 *    `403 FreeTierError` 拒绝。
 * 6. UA 不再校验（`opencode/1.18.31` 与四段式均可放过），`x-opencode-project` /
 *    `x-opencode-org-id` / `b3` / `traceparent` 均不校验；仍然照发以保持指纹完整。
 *
 * ## 偏离宿主 attribution 契约的显式记录
 *
 * 宿主 `@deepseek-ai/dsh-llm` 要求每个 provider HTTP 请求携带 `attributionHeaders()`，
 * 其 `user-agent` 实测为 `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`。
 * 而 Zen 免费车道的身份头必须是官方客户端形状，两者互斥，本插件选择**过闸**，
 * 因此在 {@link buildIdentityHeaders} 里用官方客户端身份覆盖 attribution。
 * 该头部只承载「官方客户端身份」，不携带任何用户数据。
 *
 * @module src/identity.js
 */

import { createHash } from 'node:crypto';

/** 闸门下界（历史遗留：当前闸门不校验 UA，保留门槛仅为配置卫生）。 */
export const MIN_CLIENT_VERSION = '1.18.0';

/** 默认伪装版本，取一个真实的发行版版本。 */
export const DEFAULT_CLIENT_VERSION = '2.0.24';

/** UA 的渠道段与客户端名，对齐真实发行版 `opencode/latest/<version>/cli`。 */
export const UA_CHANNEL = 'latest';
export const UA_CLIENT_NAME = 'cli';

/** `x-opencode-client`：`cli` 与 `desktop` 实测都可过闸，取其一以固定指纹。 */
export const OPENCODE_CLIENT = 'cli';

/** `x-opencode-project`：官方客户端的默认项目签名（闸门不校验其值）。 */
export const OPENCODE_PROJECT = 'global';

/** 匿名车道的池化免密凭据。当前闸门已拒绝匿名流量，仅作无 key 时的降级值。 */
export const PUBLIC_AUTHORIZATION = 'Bearer public';

/** 会话／请求 id 的形状：`ses_` / `msg_` + 12 位十六进制 + 14 位 base62。 */
export const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** 官方 session id 的随机后缀长度（base62 字符数）。 */
const SESSION_RANDOM_CHARS = 14;

/** 官方 session id 的 base62 字母表（与 opencode `Identifier.create` 一致）。 */
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ID_NAMESPACE = 'zen-proxy';

/**
 * 解析 `major.minor.patch`，容忍缺失的尾部段与前置 `v`。
 * @param {unknown} value
 * @returns {number[] | undefined} 三段数字，或无法解析时的 `undefined`
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * 比较两个已解析的版本号。
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} 负数表示 left 更旧
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * 校验配置的 OpenCode 版本是否达到闸门门槛；低于门槛或无法解析时不使用该值。
 * @param {unknown} [requested] 配置值
 * @returns {{version: string, requested: unknown, usedFallback: boolean, reason?: string}}
 */
export function resolveClientVersion(requested = DEFAULT_CLIENT_VERSION) {
  const parsed = parseVersion(requested);
  const minimum = parseVersion(MIN_CLIENT_VERSION);
  if (parsed !== undefined && compareVersions(parsed, minimum) >= 0) {
    return { version: requested.trim(), requested, usedFallback: false };
  }
  return {
    version: MIN_CLIENT_VERSION,
    requested,
    usedFallback: true,
    reason: parsed === undefined
      ? `配置的 OpenCode 版本 "${String(requested)}" 无法解析，改用门槛值 ${MIN_CLIENT_VERSION}`
      : `配置的 OpenCode 版本 ${requested.trim()} 低于闸门门槛 ${MIN_CLIENT_VERSION}，改用门槛值`,
  };
}

/**
 * 渲染 `user-agent`，与真实发行版一致的四段式。
 * @param {string} version
 * @returns {string} 形如 `opencode/latest/2.0.24/cli`
 */
export function userAgentFor(version) {
  return `opencode/${UA_CHANNEL}/${version}/${UA_CLIENT_NAME}`;
}

/**
 * 按官方算法生成一个 session id。
 *
 * 复刻 opencode `Identifier.create(true)`：48 位值 = `时间戳(ms) * 0x1000 + 计数器`，
 * 按位取反后取低 48 位（时间降序），hex 编码成 6 字节；再接 14 个 base62 随机字符。
 * 闸门校验前 12 个 hex 字符解码出的时间戳，因此**不能**用 sha256 之类的随机派生。
 * @param {number} [timestamp] 毫秒时间戳，默认当前时间
 * @returns {string} `ses_` + 12 位十六进制 + 14 位 base62
 */
export function createSessionId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = ~current;
  let time = '';
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_RANDOM_CHARS));
  const random = Array.from(bytes, (byte) => ID_ALPHABET[byte % 62]).join('');
  return `ses_${time}${random}`;
}

/** 对话标识 → 会话 id 的注册表：配额按 session 计，同一对话必须稳定复用。 */
const conversationSessions = new Map();

/**
 * 按对话稳定派生会话 id：同一对话在进程内永远是同一会话，不同对话必然不同。
 * 空对话标识退化为全局会话。
 *
 * 与旧实现的区别：旧实现按 sha256 派生（时间戳部分随机，过不了当前闸门）；
 * 现在首查注册表，未命中时用官方算法生成并登记。
 * @param {string} [conversationKey] 对话标识（宿主会话 id）
 * @returns {string}
 */
export function sessionForConversation(conversationKey) {
  const key = typeof conversationKey === 'string' && conversationKey.trim() !== ''
    ? conversationKey.trim()
    : 'global';
  let session = conversationSessions.get(key);
  if (session === undefined) {
    session = createSessionId();
    conversationSessions.set(key, session);
  }
  return session;
}

/**
 * 由任意种子派生一个闸门形状的 id：`<prefix>` + 12 位十六进制 + 14 位 base62。
 *
 * 保留给 `msg_` 请求 id 使用（闸门不校验请求 id，真实客户端甚至不发它）；
 * **session id 禁止使用本函数**——sha256 派生的时间戳部分无效。
 * @param {string} prefix `ses_` 或 `msg_`
 * @param {string} seed
 * @returns {string}
 */
export function deriveId(prefix, seed) {
  const digest = createHash('sha256').update(`${ID_NAMESPACE}\0${seed}`).digest();
  const hex = digest.subarray(0, 6).toString('hex');
  let base62 = '';
  for (const byte of digest.subarray(6, 20)) base62 += ID_ALPHABET[byte % 62];
  return `${prefix}${hex}${base62}`;
}

/**
 * 探测流量的会话：每轮一个新 session（时间戳真实即可过闸），与任何用户对话不同。
 * @returns {string}
 */
export function probeSession() {
  return createSessionId();
}

/**
 * 探测流量的请求 id：绑定「会话 + 轮次 + 模型」（闸门不校验请求 id）。
 * @param {string} round 轮次标识
 * @param {string} modelId
 * @returns {string}
 */
export function probeRequest(round, modelId) {
  return deriveId('msg_', `request\0${probeSession()}\0${round}\0${modelId}`);
}

/**
 * 一次对话的 `x-opencode-request`：由会话与轮次派生，使同一轮的多次尝试共享同一请求身份。
 * @param {string} session
 * @param {string} [turn] 轮次标识
 * @returns {string}
 */
export function requestForTurn(session, turn = '') {
  return deriveId('msg_', `request\0${session}\0${turn}`);
}

/**
 * 构造上游请求头。身份头集合与真实客户端对齐（见模块头的实测规则）。
 *
 * session 出现在**四个**头里（与真实客户端一致）：`x-opencode-session` /
 * `x-opencode-session-id` / `x-session-affinity` / `x-session-id`。实测只发
 * `x-opencode-session` 一个会被闸门以 `403 FreeTierError` 拒绝。
 *
 * **禁止发送 `x-opencode-request`**：真实客户端不发它，而 Console 的 Worker 会把它
 * 转发为 `x-opencode-request-id`，后端对带此头的请求直接 `403 FreeTierError`
 * （2026-10-15 实测单变量隔离证实）。`requestId` 仍由调用方用于本地错误分类，不上线。
 *
 * @param {{version: string, session: string, requestId?: string, stream?: boolean,
 *          apiKey?: string}} input
 *   `apiKey` 省略时退化为匿名凭据（当前闸门会拒绝，仅用于诊断可读的失败）。
 * @returns {Record<string, string>}
 */
export function buildIdentityHeaders({ version, session, requestId, stream = true, apiKey }) {
  void requestId;
  return {
    'content-type': 'application/json',
    // 偏离 dsh 的 attributionHeaders()：见本模块文件头。
    'authorization': apiKey === undefined || apiKey === '' ? PUBLIC_AUTHORIZATION : `Bearer ${apiKey}`,
    'user-agent': userAgentFor(version),
    'x-opencode-client': OPENCODE_CLIENT,
    'x-opencode-project': OPENCODE_PROJECT,
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'accept': stream ? 'text/event-stream' : '*/*',
  };
}
