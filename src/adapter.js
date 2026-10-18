/**
 * Zen 免费车道的 llm 适配器：两条 provider 路由 + 目录 + 一次对话的分发。
 *
 * 两条路由表达「分组」，而不是在模型条目上打标记——`listModels` 与
 * `normalizeModelInfo` 都没有「不可用」字段（已查证宿主契约），GUI 按 provider 分组，
 * 因此分组只能由路由表达（design D2）：
 *
 * - `opencode-free`：上游清单里的免费模型（配置 `regionModels` 指名者除外）；
 * - `opencode-free-region`：配置 `regionModels` 指名的免费模型（地区受限）。
 *
 * 目录**不做可用性判定**：探测在免费车道上自耗按会话计的配额（实测把自己打到 429），
 * 因此目录直接反映上游清单，请求失败由请求路径自己暴露。
 *
 * 本模块**结构性地**实现宿主的 `LlmAdapter` 六个可覆写点
 * （`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` /
 * `resolveModel` / `prepareCall`），但刻意**不** `import '@deepseek-ai/dsh-llm'`：
 * 该包由宿主在运行时注入，在插件仓库内不可解析，而本模块必须能被单元测试直接加载。
 * `src/register.js` 在宿主侧把本对象挂到真实 `LlmAdapter.prototype` 上，使其成为子类。
 *
 * @module src/adapter.js
 */

import { ABORTED_CODE } from './chunks.js';
import {
  outputLimitFor,
  contextWindowFor,
  displayNameFor,
  inputModalitiesFor,
  pathForModel,
  wireFor,
} from './catalog.js';
import { DEFAULT_EFFORT, budgetFor, effortsFor } from './effort.js';
import { requestUpstream } from './http.js';
import { buildIdentityHeaders, requestForTurn, resolveClientVersion, sessionForConversation } from './identity.js';
import { buildRequestFor, imageRefsOf } from './messages.js';
import { translateChatStream } from './chat.js';
import { translateResponsesStream } from './responses.js';
import { applyToolQuartet } from './tools.js';

/** 主路由：上游清单里的免费模型（配置指名的地区受限者除外）。 */
export const ROUTE_MAIN = 'opencode-free';

/** 地区路由：配置 `regionModels` 指名的免费模型，以独立分组呈现。 */
export const ROUTE_REGION = 'opencode-free-region';

/** 两条路由的展示名。 */
export const ROUTE_LABELS = Object.freeze({
  [ROUTE_MAIN]: 'OpenCode Zen 免费模型',
  [ROUTE_REGION]: 'OpenCode Zen 免费模型（地区受限）',
});

/** 注册顺序即 GUI 中的出现顺序。 */
export const ROUTES = Object.freeze([ROUTE_MAIN, ROUTE_REGION]);

/**
 * 某模型的思考强度菜单。
 *
 * 宿主只在精确模型信息里看到 `reasoning.efforts` 才会渲染档位（否则用户只能选模型、
 * 无法调节强度），因此每个已公布模型都要给菜单。容量取可溯源的输出上限，档位名称里的
 * 数字与 `streamTurn` 将要发出的预算由同一次折算得出。
 * @param {string} modelId
 * @returns {{efforts: object[], defaultEffort: string}}
 */
function reasoningFor(modelId) {
  return { efforts: effortsFor({ outputLimit: outputLimitFor(modelId) }), defaultEffort: DEFAULT_EFFORT };
}

/**
 * 派生出一次对话的会话身份。
 *
 * 免费配额按 session 计，因此会话必须按对话稳定派生，绝不能逐请求随机。
 * @param {object} options 宿主的 `GenerateOptions`
 * @returns {{session: string, requestId: string}}
 */
export function conversationIdentity(options) {
  const session = sessionForConversation(options?.sessionId);
  // 「单轮」的标识取请求里最后一条消息的 id：它在同一轮内稳定，跨轮必然变化。
  const last = Array.isArray(options?.messages) ? options.messages.at(-1) : undefined;
  const turn = typeof last?.id === 'string' && last.id !== ''
    ? last.id
    : `turn:${Array.isArray(options?.messages) ? options.messages.length : 0}`;
  return { session, requestId: requestForTurn(session, turn) };
}

/**
 * 创建一个适配器实例。
 * @param {{state: () => object, clientVersion?: string, apiKey?: () => Promise<string | undefined>,
 *          regionModels?: () => string[], regionRelay?: {url: string, token: string},
 *          fetchImpl?: typeof fetch, attachments?: object, timeoutMs?: number}} deps
 *   `state` 返回最近一次清单（`{models: string[]}`，由 `src/state.js` 持久化）；
 *   `apiKey` 是凭据取值函数（见 `src/credentials.js`）：**每个请求现调一次**，
 *   换号重登或配置改 key 后立即生效，不持有注册时的旧值；
 *   `regionModels` 返回配置里指名的地区受限模型 id（每请求现读，改配置即生效）；
 *   `regionRelay` 是区域中继（可选）：region 组的模型经它收发；
 *   `attachments` 是宿主的 attachment 服务（可选）：图片字节由它按请求尺寸生成。
 * @returns {object} 六点齐全的适配器
 */
export function createAdapter({ state, clientVersion, apiKey, regionModels, regionRelay, fetchImpl, timeoutMs, attachments }) {
  const version = clientVersion ?? resolveClientVersion().version;

  /** 配置指名的地区受限集合（现读，改配置即生效）。 */
  function regionSet() {
    return new Set(Array.isArray(regionModels?.()) ? regionModels() : []);
  }

  function modelEntry(provider, modelId) {
    const contextWindow = contextWindowFor(modelId);
    return {
      provider,
      id: modelId,
      name: displayNameFor(modelId),
      inputModalities: [...inputModalitiesFor(modelId)],
      // 只在有可溯源来源时给出上下文窗口；无来源就省略（见 src/catalog.js）。
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      // 不声明 defaultMaxTokens：宿主会把它物化成请求的输出上限，而它与档位无关，
      // 无法表达思考强度差异（见 design 的 D20）。
      reasoning: reasoningFor(modelId),
    };
  }

  return {
    /**
     * 路由的展示元数据。宿主校验 `id` 必须等于注册的路由、`name` 必须非空。
     * @param {string} provider
     * @returns {{id: string, name: string}}
     */
    providerInfo(provider) {
      return { id: provider, name: ROUTE_LABELS[provider] ?? provider };
    },

    /** 使用宿主默认的重试策略。 */
    providerRetryPolicy() {
      return undefined;
    },

    /** 不按视觉 token 计价。 */
    imageRequestPricing() {
      return undefined;
    },

    /**
     * 宿主据此决定把图片压缩到多大再交给适配器。
     * 本车道不额外限制：沿用归一化后的原图尺寸与字节数。
     * @param {string} provider
     * @param {string} model
     * @param {{width: number, height: number, bytes: number}} image
     * @returns {{width: number, height: number, maxBytes: number}}
     */
    imageRequestTarget(provider, model, image) {
      void provider;
      void model;
      return { width: image.width, height: image.height, maxBytes: image.bytes };
    },

    /**
     * 公布一个路由的目录：上游清单里的免费模型，按配置的 region 分组拆到两条路由。
     * @param {string} provider
     * @returns {object[]}
     */
    listModels(provider) {
      if (provider !== ROUTE_MAIN && provider !== ROUTE_REGION) return [];
      const models = Array.isArray(state()?.models) ? state().models : [];
      const region = regionSet();
      const ids = provider === ROUTE_REGION
        ? models.filter((id) => region.has(id))
        : models.filter((id) => !region.has(id));
      return ids.map((modelId) => ({
        provider,
        id: modelId,
        name: displayNameFor(modelId),
        inputModalities: [...inputModalitiesFor(modelId)],
      }));
    },

    /**
     * 精确模型信息。核心路由接受未列出的 id，所以任何 id 都必须能解析出合法结果。
     * @param {string} provider
     * @param {string} model
     * @returns {object}
     */
    resolveModel(provider, model) {
      const entry = modelEntry(provider, model);
      return {
        provider: entry.provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.inputModalities,
        ...entry.context === undefined ? {} : { context: entry.context },
        reasoning: entry.reasoning,
      };
    },

    /**
     * 绑定精确模型信息与一次流式分发。
     * @param {string} provider
     * @param {string} model
     * @returns {Promise<{model: object, stream: (options: object) => AsyncGenerator<object>}>}
     */
    async prepareCall(provider, model) {
      const resolved = this.resolveModel(provider, model);
      return {
        model: resolved,
        stream: (options) => streamTurn(options, { version, apiKey, regionModels, regionRelay, fetchImpl, timeoutMs, attachments }),
      };
    },
  };
}

/**
 * 把消息里的图片块解析成 `attachmentId → data URL`。
 *
 * 宿主的 `ImageBlock` 只带 `attachment` 引用，字节由 attachment 服务按请求尺寸
 * 生成（`readImageRequest`）。没有服务或取不到字节时返回空 Map，图片块会被丢弃。
 *
 * @param {unknown} messages
 * @param {{readImageRequest?: Function} | undefined} attachments
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Map<string, string>>}
 */
async function resolveImages(messages, attachments, signal) {
  const images = new Map();
  if (typeof attachments?.readImageRequest !== 'function') return images;
  for (const ref of imageRefsOf(messages)) {
    try {
      const version = await attachments.readImageRequest(
        ref,
        { width: ref.width, height: ref.height, maxBytes: ref.bytes },
        signal,
      );
      const b64 = Buffer.from(version.data).toString('base64');
      images.set(ref.attachmentId, `data:${version.mediaType};base64,${b64}`);
    } catch {
      // 单张图取失败不应中断整轮：该块被丢弃，其余文本与图片照发。
    }
  }
  return images;
}

/**
 * 一次对话的流式分发：构造请求、发往对应协议族、把响应流翻译成宿主分片。
 *
 * 失败以「抛出带 `code` 与 `failure` 自有属性的 Error」交付；宿主会把它转成终止失败
 * 分片。取消则本流自己产出一个 `{kind:'aborted'}` 的终止 `finish`。
 * @param {object} options 宿主的 `GenerateOptions`
 * @param {{version: string, apiKey?: () => Promise<string | undefined>, regionModels?: () => string[],
 *          regionRelay?: {url: string, token: string}, fetchImpl?: typeof fetch, timeoutMs?: number,
 *          attachments?: object}} context
 * @returns {AsyncGenerator<object>}
 */
async function* streamTurn(options, { version, apiKey, regionModels, regionRelay, fetchImpl, timeoutMs, attachments }) {
  const modelId = String(options?.model ?? '');
  const signal = options?.signal;
  if (signal?.aborted === true) {
    yield {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: Object.freeze({ message: 'the request was aborted by the caller', code: ABORTED_CODE }),
      },
    };
    return;
  }
  // 凭据每请求现取：注册后换 key / opencode 重登都在这里反映出来。
  const bearer = await apiKey?.();

  const wire = wireFor(modelId);
  const { session, requestId } = conversationIdentity(options);
  const { tools, rename, toolChoice } = applyToolQuartet(options?.tools, { style: wire, toolChoice: true });
  // 图片块只带 attachment 引用，字节要经宿主的 attachment 服务取出后交给 wire。
  const images = await resolveImages(options?.messages, attachments, signal);
  const body = buildRequestFor(wire, {
    model: modelId,
    messages: options?.messages,
    images,
    tools,
    toolChoice,
    // 本车道唯一被执行的强度旋钮：把宿主解析出的档位折算成输出上限。
    // 调用方给了上限时以它为容量上限，档位不突破它。
    maxTokens: budgetFor(options?.reasoningEffort, { outputLimit: outputLimitFor(modelId) }, options?.maxTokens),
    temperature: options?.temperature,
    stop: options?.stop,
  });
  const headers = buildIdentityHeaders({ version, session, requestId, stream: true, apiKey: bearer });
  // 配置指名的地区受限模型经中继收发（现读配置，改了即生效）。
  const viaRelay = regionRelay !== undefined && (regionModels?.() ?? []).includes(modelId);
  if (viaRelay) {
    headers['x-zen-relay-token'] = regionRelay.token;
  }

  const { payloads } = await requestUpstream({
    path: pathForModel(modelId),
    headers,
    body,
    signal,
    fetchImpl,
    timeoutMs,
    requestId,
    ...(viaRelay ? { baseUrl: regionRelay.url } : {}),
  });

  const translate = wire === 'responses' ? translateResponsesStream : translateChatStream;
  yield* translate(payloads ?? [], { requestId, rename, signal });
}
