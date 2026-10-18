/**
 * `src/catalog.js`：清单解析、免费过滤、协议族判定与可溯源能力元数据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATALOG_METADATA_UNKNOWN,
  CHAT_COMPLETIONS_PATH,
  RESPONSES_PATH,
  UPSTREAM_BASE_URL,
  acceptsImage,
  capabilityOf,
  contextWindowFor,
  displayNameFor,
  freeCandidates,
  hasTraceableCapabilities,
  inputModalitiesFor,
  isFreeModel,
  isResponsesModel,
  loadCapabilities,
  outputLimitFor,
  parseListing,
  pathForModel,
  pathForWire,
  resetCapabilities,
  setCapabilityOverrides,
  wireFor,
} from '../src/catalog.js';

/** 预置能力表：形状与 models.dev 的 `opencode.models[id]` 一致。 */
async function seed(models) {
  resetCapabilities();
  await loadCapabilities({ fetchImpl: async () => ({ ok: true, json: async () => ({ opencode: { models } }) }) });
}

/** 真实清单的形状（实测：只有 id / object / created / owned_by）。 */
const LISTING = {
  object: 'list',
  data: [
    { id: 'claude-fable-5', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'fledge-alpha-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'exo-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'muse-spark-1.3-contributor-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'jev-1.13-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
  ],
};

describe('parseListing', () => {
  it('从 {data:[{id}]} 里取出 id 并去重', () => {
    assert.deepEqual(parseListing(LISTING), [
      'claude-fable-5',
      'fledge-alpha-free',
      'exo-free',
      'muse-spark-1.3-contributor-free',
      'jev-1.13-free',
    ]);
    assert.deepEqual(parseListing({ data: [{ id: 'a' }, { id: 'a' }] }), ['a']);
    assert.deepEqual(parseListing({ data: ['b', { id: '' }, 3] }), ['b']);
    assert.deepEqual(parseListing(undefined), []);
  });
});

describe('免费过滤', () => {
  it('只保留 -free 结尾的 id', () => {
    assert.deepEqual(freeCandidates(LISTING), [
      'fledge-alpha-free',
      'exo-free',
      'muse-spark-1.3-contributor-free',
      'jev-1.13-free',
    ]);
    assert.equal(isFreeModel('claude-fable-5'), false);
    assert.equal(isFreeModel('free'), false);
    assert.equal(isFreeModel('-free'), false);
    assert.equal(isFreeModel('mimo-v2.6-flash-free'), true);
  });
});

describe('协议族判定', () => {
  it('muse-spark 系走 responses，其余走 chat', () => {
    assert.equal(wireFor('muse-spark-1.3-contributor-free'), 'responses');
    assert.equal(wireFor('muse-spark-1.2-contributor-free'), 'responses');
    assert.equal(wireFor('muse_spark-1.4-free'), 'responses');
    assert.equal(wireFor('fledge-alpha-free'), 'chat');
    assert.equal(wireFor('nemotron-3-ultra-free'), 'chat');
    assert.equal(wireFor('openrouter/muse-spark-x'), 'responses');
    assert.equal(isResponsesModel('fledge-alpha-free'), false);
  });

  it('端点路径按协议族选择，其余地址只有上游 base URL', () => {
    assert.equal(pathForWire('chat'), CHAT_COMPLETIONS_PATH);
    assert.equal(pathForWire('responses'), RESPONSES_PATH);
    assert.equal(pathForModel('muse-spark-1.3-contributor-free'), RESPONSES_PATH);
    assert.equal(pathForModel('fledge-alpha-free'), CHAT_COMPLETIONS_PATH);
    assert.equal(UPSTREAM_BASE_URL, 'https://opencode.ai/zen/v1');
  });
});

describe('能力元数据（运行时取自 models.dev 并透传）', () => {
  const MODELS = {
    'fledge-alpha-free': { limit: { context: 1048576, output: 131072 }, modalities: { input: ['text', 'image'] } },
    'nemotron-3.5-lightning-free': { limit: { context: 262144, output: 262144 }, modalities: { input: ['text'] } },
    'mimo-v2.6-flash-free': {
      limit: { context: 200000, output: 32000 },
      modalities: { input: ['text', 'image', 'audio', 'video'] },
    },
  };

  it('能力表就绪后按 id 给出窗口与输出上限', async () => {
    await seed(MODELS);
    assert.equal(contextWindowFor('fledge-alpha-free'), 1048576);
    assert.equal(contextWindowFor('nemotron-3.5-lightning-free'), 262144);
    assert.equal(outputLimitFor('fledge-alpha-free'), 131072);
    assert.equal(outputLimitFor('mimo-v2.6-flash-free'), 32000);
    assert.equal(hasTraceableCapabilities('fledge-alpha-free'), true);
    assert.deepEqual(Object.keys(capabilityOf('fledge-alpha-free') ?? {}).sort(), ['limit', 'modalities']);
  });

  it('占位形 id 与大小写无关：走 baseModelId 归一到基名', async () => {
    await seed(MODELS);
    const bare = contextWindowFor('fledge-alpha-free');
    assert.equal(bare, 1048576);
    // 带模型级后缀的写法应归一到同一基名。
    assert.equal(contextWindowFor('fledge-alpha-free (latest)'), bare);
  });

  it('能力表里的模型透传模态；宿主不认识的 video/audio 被忽略', async () => {
    await seed(MODELS);
    assert.deepEqual(inputModalitiesFor('fledge-alpha-free'), ['text', 'image']);
    assert.equal(acceptsImage('fledge-alpha-free'), true);
    // 仅声明 text 的模型仍然只给 text。
    assert.deepEqual(inputModalitiesFor('nemotron-3.5-lightning-free'), ['text']);
    assert.equal(acceptsImage('nemotron-3.5-lightning-free'), false);
    // 上游声明了 video/audio，但宿主的模态词汇表只有 text 与 image。
    assert.deepEqual(inputModalitiesFor('mimo-v2.6-flash-free'), ['text', 'image']);
  });

  it('能力表里没有的 id 回退为纯文本、无窗口', async () => {
    await seed(MODELS);
    assert.equal(contextWindowFor('jev-1.13-free'), undefined);
    assert.equal(contextWindowFor('some-future-model-free'), undefined);
    assert.equal(outputLimitFor('jev-1.13-free'), undefined);
    assert.equal(hasTraceableCapabilities('jev-1.13-free'), false);
    assert.deepEqual(inputModalitiesFor('jev-1.13-free'), ['text']);
    assert.equal(acceptsImage('jev-1.13-free'), false);
  });

  it('能力表未加载时一切按纯文本、无窗口处理，且不抛错', () => {
    resetCapabilities();
    assert.equal(contextWindowFor('fledge-alpha-free'), undefined);
    assert.equal(outputLimitFor('fledge-alpha-free'), undefined);
    assert.equal(capabilityOf('fledge-alpha-free'), undefined);
    assert.deepEqual(inputModalitiesFor('fledge-alpha-free'), ['text']);
    assert.equal(acceptsImage('fledge-alpha-free'), false);
    assert.equal(hasTraceableCapabilities('fledge-alpha-free'), false);
  });

  it('拉取失败（非 2xx 或抛错）返回 undefined 且不缓存坏值', async () => {
    resetCapabilities();
    assert.equal(await loadCapabilities({ fetchImpl: async () => ({ ok: false, status: 500 }) }), undefined);
    resetCapabilities();
    assert.equal(await loadCapabilities({ fetchImpl: async () => { throw new Error('network down') } }), undefined);
    // 失败后仍未缓存：模型仍按纯文本处理。
    assert.equal(capabilityOf('fledge-alpha-free'), undefined);
  });

  it('成功加载后命中缓存：第二次调用不再发起请求', async () => {
    resetCapabilities();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ opencode: { models: MODELS } }) } };
    await loadCapabilities({ fetchImpl });
    await loadCapabilities({ fetchImpl });
    assert.equal(calls, 1, '缓存命中后不应重复拉取');
  });

  it('诊断码是稳定字符串', () => {
    assert.equal(CATALOG_METADATA_UNKNOWN, 'CATALOG_METADATA_UNKNOWN');
  });
});

describe('能力覆盖（插件配置 capabilities，优先于 models.dev）', () => {
  const MODELS = {
    'fledge-alpha-free': { limit: { context: 1048576, output: 131072 }, modalities: { input: ['text', 'image'] } },
  };

  it('覆盖字段赢，未覆盖字段保持透传', async () => {
    await seed(MODELS);
    setCapabilityOverrides({
      'fledge-alpha-free': { limit: { context: 4096 } },
    });
    assert.equal(contextWindowFor('fledge-alpha-free'), 4096);
    assert.equal(outputLimitFor('fledge-alpha-free'), 131072, '未覆盖的 output 仍来自 models.dev');
    assert.deepEqual(inputModalitiesFor('fledge-alpha-free'), ['text', 'image']);
  });

  it('models.dev 没有的模型可以只靠覆盖拿全元数据（jev-1.13-free 形态）', async () => {
    await seed(MODELS);
    setCapabilityOverrides({
      'jev-1.13-free': { limit: { context: 262144, output: 32768 }, modalities: { input: ['text', 'image'] } },
    });
    assert.equal(contextWindowFor('jev-1.13-free'), 262144);
    assert.equal(outputLimitFor('jev-1.13-free'), 32768);
    assert.deepEqual(inputModalitiesFor('jev-1.13-free'), ['text', 'image']);
    assert.equal(acceptsImage('jev-1.13-free'), true);
    assert.equal(hasTraceableCapabilities('jev-1.13-free'), true);
  });

  it('每轮重设：传 undefined 清空覆盖，回到纯透传', async () => {
    await seed(MODELS);
    setCapabilityOverrides({ 'fledge-alpha-free': { limit: { context: 4096 } } });
    assert.equal(contextWindowFor('fledge-alpha-free'), 4096);
    setCapabilityOverrides(undefined);
    assert.equal(contextWindowFor('fledge-alpha-free'), 1048576);
  });

  it('非法覆盖值被既有的合法值检查忽略，不抛错', async () => {
    await seed(MODELS);
    setCapabilityOverrides({
      'fledge-alpha-free': { limit: { context: -1, output: 'lots' }, modalities: { input: ['video'] } },
    });
    // -1 与 'lots' 不是正整数 → 既有的守卫把它们当作无值；input 里没有 image → 纯文本。
    assert.equal(contextWindowFor('fledge-alpha-free'), undefined);
    assert.equal(outputLimitFor('fledge-alpha-free'), undefined);
    assert.deepEqual(inputModalitiesFor('fledge-alpha-free'), ['text']);
  });

  it('占位形 id 走 baseModelId 归一后命中覆盖', async () => {
    await seed(MODELS);
    setCapabilityOverrides({ 'fledge-alpha-free': { limit: { context: 4096 } } });
    assert.equal(contextWindowFor('fledge-alpha-free (latest)'), 4096);
  });
});

describe('displayNameFor', () => {
  it('把上游 id 渲染成可展示的名字', () => {
    assert.equal(displayNameFor('fledge-alpha-free'), 'Fledge Alpha Free');
    assert.equal(displayNameFor('nemotron-3.5-lightning-free'), 'Nemotron 3.5 Lightning Free');
    assert.equal(displayNameFor('jev-1.13-free'), 'Jev 1.13 Free');
    assert.notEqual(displayNameFor('exo-free'), '');
  });
});
