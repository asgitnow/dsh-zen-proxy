/**
 * `src/register.js` 与入口 `index.js`：注册面、清单驱动目录、区域分组、卸载释放与源码卫生。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js';
import { register } from '../src/register.js';
import { chatFinishFrame, chatFrame, collect, fakeFetch, fakeLogger, jsonResponse, sseResponse } from './fake-upstream.js';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'zen-proxy-register-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 提取源码里所有模块说明符的正则集合。**两处用例共享这一份**：卫生用例用它扫 `src/`，
 * 对抗用例用它验证每种引入形态都能被抓到。若各持一份副本，卫生用例退化时对抗用例仍会
 * 拿自己的副本自证全绿（这正是它要消除的假绿）。
 *
 * 覆盖宿主包可能被引入的全部形态，缺一种就是一个盲区：
 *   1. 静态 `import ... from 'x'` / `export ... from 'x'`（单双引号）
 *   2. 裸副作用导入 `import 'x'`
 *   3. 动态 `import('x')`（单双引号与模板字符串）
 *   4. CJS `require('x')`
 */
const SPECIFIER_PATTERNS = Object.freeze([
  /(?:^|[\s;{(])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/gm,
  /(?:^|[\s;{(])import\s*['"]([^'"]+)['"]/gm,
  /import\s*\(\s*(?:['"]([^'"]+)['"]|`([^`$]+)`)\s*\)/gm,
  /(?:^|[^\w$.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
]);

/** 用共享正则集合抽取一段源码里的全部说明符（去重）。 */
function specifiersIn(text) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return found;
}

/** 一个够用的假 cordis 上下文。 */
function fakeContext({ settingsId = 'zen-proxy' } = {}) {
  const disposers = [];
  const adapterCalls = [];
  const directoryCalls = [];
  const logger = fakeLogger();
  return {
    logger,
    adapterCalls,
    directoryCalls,
    disposers,
    fiber: { entry: { options: { id: settingsId } } },
    llm: {
      registerAdapter(providers, adapter) {
        adapterCalls.push({ providers: [...providers], adapter });
        return { replace: () => {} };
      },
      registerConfigurableProviders(entries) {
        directoryCalls.push(entries);
        return { replace: () => {} };
      },
    },
    effect(callback, label) {
      const disposer = callback();
      disposers.push({ label, disposer });
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };
}

/** 上游桩：只服务清单（目录不做探测，这是唯一会被打到的上游端点）。 */
function upstreamStub({ listing }) {
  return fakeFetch((url) => {
    if (url.endsWith('/models')) return jsonResponse({ object: 'list', data: listing.map((id) => ({ id, object: 'model' })) });
    throw new TypeError(`清单桩之外的请求: ${url}`);
  });
}

/** 一个永远失败的 fetch 桩：让 register 里自动发起的首轮刷新不真的碰网络。 */
const noNetwork = () => fakeFetch(() => { throw new TypeError('offline test'); }).fetch;

const LISTING = [
  { id: 'claude-fable-5' },
  { id: 'fledge-alpha-free' },
  { id: 'nemotron-3.5-lightning-free' },
  { id: 'muse-spark-1.3-contributor-free' },
];

describe('注册面', () => {
  it('以两条路由注册适配器，并声明两个可配置 provider', () => {
    const ctx = fakeContext();
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: noNetwork(),
    });

    assert.equal(ctx.adapterCalls.length, 1);
    assert.deepEqual(ctx.adapterCalls[0].providers, [ROUTE_MAIN, ROUTE_REGION]);
    assert.equal(typeof ctx.adapterCalls[0].adapter.providerInfo, 'function');

    assert.equal(ctx.directoryCalls.length, 1);
    const entries = ctx.directoryCalls[0];
    assert.deepEqual(entries.map((entry) => entry.provider), [ROUTE_MAIN, ROUTE_REGION]);
    for (const entry of entries) {
      assert.ok(entry.displayName.length > 0, 'displayName 非空');
      assert.ok(entry.settingsNs.length > 0, 'settingsNs 非空');
      assert.deepEqual(entry.settingsPath, []);
    }
    assert.equal(entries[0].settingsNs, 'zen-proxy');
    assert.equal(handle.routes.length, 2);
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('settingsNs 取宿主 fiber 的插件 id', () => {
    const ctx = fakeContext({ settingsId: 'custom-id' });
    register(ctx, { probeIntervalMinutes: 10 }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: noNetwork() });
    assert.equal(ctx.directoryCalls[0][0].settingsNs, 'custom-id');
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('probeIntervalMinutes 默认为 10', () => {
    const ctx = fakeContext();
    const handle = register(ctx, {}, { stateFile: join(tempDir(), 'state.json'), fetchImpl: noNetwork() });
    assert.equal(handle.scheduler.nextDelayMs, 10 * 60_000);
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('运行中修改探测周期，下一轮起采用新值（无需重启进程）', async () => {
    const ctx = fakeContext();
    const config = { probeIntervalMinutes: 10 };
    const { fetch } = upstreamStub({ listing: ['fledge-alpha-free'] });
    const handle = register(ctx, config, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    assert.equal(handle.scheduler.nextDelayMs, 10 * 60_000);

    config.probeIntervalMinutes = 3;
    await handle.runRound();

    assert.equal(handle.scheduler.nextDelayMs, 3 * 60_000, '重新武装时读取新周期');
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('低于门槛的 OpenCode 版本被回退并记录诊断', () => {
    const ctx = fakeContext();
    const handle = register(ctx, { opencodeVersion: '1.17.0' }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: noNetwork(),
    });
    assert.ok(ctx.logger.lines.warn.some((line) => line.includes('1.17.0')));
    assert.ok(handle.adapter.providerInfo(ROUTE_MAIN).name.length > 0);
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('卸载时停止探测并释放路由', async () => {
    const ctx = fakeContext();
    const { fetch, calls } = upstreamStub({ listing: LISTING.map((entry) => entry.id) });
    register(ctx, { probeIntervalMinutes: 10 }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    // 等首轮清单拉取落定，再卸载。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = calls.length;
    for (const entry of ctx.disposers) entry.disposer();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, before, '卸载后不得再发起上游请求');
  });
});

describe('一轮清单驱动目录', () => {
  it('免费候选全部直接进目录；regionModels 指名的拆到地区路由；付费模型被过滤', async () => {
    const ctx = fakeContext();
    const listing = [
      'claude-fable-5',
      'fledge-alpha-free',
      'nemotron-3.5-lightning-free',
      'muse-spark-1.3-contributor-free',
      'exo-free',
      'jev-1.13-free',
    ];
    const { fetch } = upstreamStub({ listing });
    const handle = register(ctx, {
      probeIntervalMinutes: 10,
      regionModels: ['muse-spark-1.3-contributor-free', 'exo-free'],
    }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    const outcome = await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();

    assert.deepEqual(outcome.candidates, ['fledge-alpha-free', 'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free', 'exo-free', 'jev-1.13-free']);
    const adapter = ctx.adapterCalls[0].adapter;
    assert.deepEqual((await adapter.listModels(ROUTE_MAIN)).map((model) => model.id), [
      'fledge-alpha-free',
      'nemotron-3.5-lightning-free',
      'jev-1.13-free',
    ]);
    assert.deepEqual(
      (await adapter.listModels(ROUTE_REGION)).map((model) => model.id),
      ['muse-spark-1.3-contributor-free', 'exo-free'],
    );
    for (const provider of [ROUTE_MAIN, ROUTE_REGION]) {
      assert.equal((await adapter.listModels(provider)).some((model) => model.id === 'claude-fable-5'), false, '付费模型不得出现');
    }
  });

  it('目录不做探测：一轮只打一次上游（清单）', async () => {
    const ctx = fakeContext();
    const { fetch, calls } = upstreamStub({ listing: ['a-free', 'b-free'] });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch,
    });
    // register 挂载即自动跑首轮（fakeContext 的 effect 同步触发）+ 手动 runRound：
    // 恰好两次清单请求，除此之外不得有任何上游请求（不逐模型探测）。
    await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();

    const adapter = ctx.adapterCalls[0].adapter;
    assert.deepEqual((await adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['a-free', 'b-free']);
    // 对 zen 上游：自动首轮 + 手动一轮，各一次清单请求，除此之外不得有任何请求（无探测流量）。
    // 对 models.dev 的能力表拉取是另一条线路（每进程一次），不在本断言范围。
    const listingCalls = calls.filter((call) => call.url.endsWith('/zen/v1/models'));
    assert.equal(listingCalls.length, 2, '自动首轮 + 手动一轮，各一次清单请求');
    const probeTraffic = calls.filter((call) => call.url.includes('/zen/v1/') && !call.url.endsWith('/zen/v1/models'));
    assert.deepEqual(probeTraffic, [], '不得有 chat/completions 或 responses 探测请求');
  });

  it('没有可溯源元数据的免费模型仍进入目录，并记录一条诊断', async () => {
    const ctx = fakeContext();
    const { fetch } = upstreamStub({ listing: ['jev-1.13-free'] });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: fetch,
    });
    await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();

    const adapter = ctx.adapterCalls[0].adapter;
    const ids = (await adapter.listModels(ROUTE_MAIN)).map((model) => model.id);
    assert.deepEqual(ids, ['jev-1.13-free'], '目录不因元数据缺失而收缩');
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'jev-1.13-free');
    assert.equal('context' in resolved, false);
    assert.ok(ctx.logger.lines.warn.some((line) => line.includes('CATALOG_METADATA_UNKNOWN') && line.includes('jev-1.13-free')));
  });

  it('清单拉取失败时本轮作废，既有目录保持不动', async () => {
    const ctx = fakeContext();
    const stateFile = join(tempDir(), 'state.json');
    const good = upstreamStub({ listing: ['fledge-alpha-free'] });
    const first = register(ctx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: good.fetch });
    await first.runRound();
    assert.deepEqual((await ctx.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['fledge-alpha-free']);
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();

    const secondCtx = fakeContext();
    const broken = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const second = register(secondCtx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: broken.fetch });
    await second.runRound();
    assert.deepEqual(
      (await secondCtx.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id),
      ['fledge-alpha-free'],
      '一次拉取失败不得清空目录',
    );
    secondCtx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('免费候选按新形状持久化到传入的状态文件', async () => {
    const ctx = fakeContext();
    const stateFile = join(tempDir(), 'state.json');
    const { fetch } = upstreamStub({ listing: ['fledge-alpha-free', 'beam-free'] });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: fetch });
    await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();

    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.models, ['fledge-alpha-free', 'beam-free']);
    assert.ok(Number.isSafeInteger(persisted.updatedAt) && persisted.updatedAt > 0);
  });

  it('跨重启保留上次清单：新实例在首轮完成前即反映旧目录', async () => {
    const stateFile = join(tempDir(), 'state.json');
    const first = fakeContext();
    const stub = upstreamStub({ listing: ['fledge-alpha-free'] });
    const a = register(first, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: stub.fetch });
    await a.runRound();
    first.disposers.find((entry) => entry.label.includes('listing')).disposer();

    const second = fakeContext();
    const broken = fakeFetch(() => { throw new TypeError('offline'); });
    register(second, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: broken.fetch });
    assert.deepEqual(
      (await second.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id),
      ['fledge-alpha-free'],
    );
    second.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('regionModels 每轮现读：运行中改配置，下一轮分组即变', async () => {
    const ctx = fakeContext();
    const config = { probeIntervalMinutes: 10, regionModels: [] };
    const { fetch } = upstreamStub({ listing: ['fledge-alpha-free', 'beam-free'] });
    const handle = register(ctx, config, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    await handle.runRound();
    const adapter = ctx.adapterCalls[0].adapter;
    assert.deepEqual((await adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['fledge-alpha-free', 'beam-free']);

    config.regionModels = ['beam-free'];
    await handle.runRound();
    assert.deepEqual((await adapter.listModels(ROUTE_REGION)).map((model) => model.id), ['beam-free']);
    assert.deepEqual((await adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['fledge-alpha-free']);
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });
});

describe('区域中继', () => {
  it('regionModels 指名的模型对话经中继并携带令牌', async () => {
    const ctx = fakeContext();
    // muse-spark 走 responses 协议族，对话按 responses 事件返回。
    const okResponses = () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }),
      JSON.stringify({ type: 'response.completed' }),
    ]);
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.includes('relay.example')) return okResponses();
      if (url.endsWith('/models')) return jsonResponse({ object: 'list', data: [{ id: 'muse-spark-1.3-contributor-free' }] });
      throw new TypeError(`清单桩之外的请求: ${url}`);
    });
    const handle = register(ctx, {
      probeIntervalMinutes: 10,
      regionModels: ['muse-spark-1.3-contributor-free'],
      regionRelayUrl: 'https://relay.example',
      regionRelayToken: 'tok-1',
    }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    await handle.runRound();

    const adapter = ctx.adapterCalls[0].adapter;
    assert.deepEqual((await adapter.listModels(ROUTE_REGION)).map((model) => model.id), ['muse-spark-1.3-contributor-free']);

    const prepared = await adapter.prepareCall(ROUTE_REGION, 'muse-spark-1.3-contributor-free');
    await collect(prepared.stream({
      model: 'muse-spark-1.3-contributor-free',
      sessionId: 'ses-x',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }] }],
    }));
    const relayCalls = calls.filter((call) => call.url.includes('relay.example'));
    assert.ok(relayCalls.length >= 1, '对话请求应命中中继');
    for (const call of relayCalls) {
      assert.match(call.url, /^https:\/\/relay\.example\/(?:chat\/completions|responses)$/);
      assert.equal(call.init.headers['x-zen-relay-token'], 'tok-1');
    }
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
  });

  it('指名了 regionModels 但未配置中继时记录一条警告', async () => {
    const ctx = fakeContext();
    const { fetch } = upstreamStub({ listing: ['beam-free'] });
    const handle = register(ctx, { probeIntervalMinutes: 10, regionModels: ['beam-free'] }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: fetch,
    });
    await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('listing')).disposer();
    assert.ok(ctx.logger.lines.warn.some((line) => line.includes('regionModels') && line.includes('regionRelayUrl')));
  });
});

describe('入口 index.js', () => {
  it('导出宿主约定的 name / inject / Config / apply', async () => {
    const entry = await import('../index.js');
    assert.equal(entry.name, 'zen-proxy');
    assert.deepEqual(entry.inject, ['llm']);
    assert.equal(typeof entry.apply, 'function');
    const parsed = entry.Config({});
    assert.equal(parsed.probeIntervalMinutes, 10);
    assert.equal(parsed.opencodeVersion, '2.0.24');
    assert.equal(parsed.apiKey, '');
    assert.deepEqual(parsed.capabilities, {});
  });
});

describe('源码卫生', () => {
  it('除上游 base URL 外没有写死的用户目录绝对路径', () => {
    const root = new URL('../', import.meta.url);
    const files = [
      new URL('index.js', root),
      ...readdirSync(new URL('src/', root)).map((name) => new URL(`src/${name}`, root)),
    ];
    const pattern = /(['"`])(?:[A-Za-z]:[\\/]|\/home\/|\/Users\/|\/root\/)/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const hits = [...text.matchAll(pattern)].map((match) => match[0]);
      assert.deepEqual(hits, [], `${file.pathname} 含有写死的绝对路径：${hits.join(', ')}`);
    }
  });

  it('src/ 的模块只依赖 Node 内建与同目录模块', () => {
    const root = new URL('../', import.meta.url);
    // 正则集合与「对抗用例」共享（见文件顶部的 SPECIFIER_PATTERNS 注释）。
    // 唯一允许的宿主包引用：register.js 用动态 import 尝试取宿主基类，失败即保持普通对象
    // （见该文件 adoptHostBaseClass 的注释），因此按文件白名单放行。
    const allowedHost = new Map([['register.js', '@deepseek-ai/dsh-llm']]);
    let checked = 0;
    for (const name of readdirSync(new URL('src/', root))) {
      const file = new URL('src/' + name, root);
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        checked += 1;
        if (specifier.startsWith('./') || specifier.startsWith('node:')) continue;
        assert.equal(
          allowedHost.get(name),
          specifier,
          file.pathname + ' 依赖了 ' + specifier + '；src/ 不允许依赖宿主包',
        );
      }
    }
    // 计数型检查必须能回答「检查了几个对象」：正则若失效，上面的断言会全部落空而仍然通过。
    // 阈值 32 是本机实测的**去重后**说明符数（`scripts/count-imports.mjs`；探测状态机
    // 移除后 src/ 共 10 个模块）。它只兜住「整体扫不到东西」这一类失效；
    // 「漏抓某一种写法」由下面的对抗用例负责，两者分工不同。
    assert.ok(checked > 0, '未匹配到任何 import，检查逻辑可能已失效');
    assert.ok(checked >= 32, `受检 import 数异常偏少：${checked}`);
  });

  it('依赖检查的正则覆盖裸导入、模板字符串与 require', () => {
    // 对抗用例：用**与卫生用例共享的同一份正则**验证每种引入形态都能被抓到。
    // 共享是关键：若各持副本，卫生用例退化后本用例仍会全绿（N3 的假绿形态）。
    const samples = [
      ["import x from '@a/static'", '@a/static'],
      ["import { a } from \"@a/double\"", '@a/double'],
      ["export { a } from '@a/export'", '@a/export'],
      ["import '@a/bare'", '@a/bare'],
      ["void import('@a/dynamic')", '@a/dynamic'],
      ['void import(`@a/template`)', '@a/template'],
      ["const m = require('@a/require')", '@a/require'],
    ];
    for (const [code, expected] of samples) {
      assert.equal(specifiersIn(code).has(expected), true, `未抓到 ${expected}（源码：${code}）`);
    }
    // 反向：确认这四种形态各自都被用到（删掉任一正则会让对应用例失败，从而暴露退化）。
    for (const code of ["import '@a/bare'", 'void import(`@a/template`)', "require('@a/require')"]) {
      assert.equal(specifiersIn(code).size, 1, `形态未被独立识别：${code}`);
    }
  });

  it('cordis.patch.yml 的条目 name 与 package.json 的 name 一致', () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8');
    assert.match(patch, new RegExp(`id:\\s*zen-proxy`));
    assert.ok(patch.includes(`name: '${manifest.name}'`), 'loader 条目的 name 必须等于包名');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.dsh.client, undefined, '本插件没有浏览器半身');
    assert.equal(manifest.scripts.test, 'node --test test/*.test.js');
    assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'] !== undefined, true);
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-llm'] !== undefined, true);
  });
});
