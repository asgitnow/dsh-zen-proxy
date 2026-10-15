/**
 * `src/identity.js`：身份头齐备、版本门槛、会话 id 派生与凭据装配。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_CLIENT_VERSION,
  OPENCODE_CLIENT,
  OPENCODE_PROJECT,
  PUBLIC_AUTHORIZATION,
  REQUEST_PATTERN,
  SESSION_PATTERN,
  buildIdentityHeaders,
  compareVersions,
  createSessionId,
  parseVersion,
  probeRequest,
  probeSession,
  requestForTurn,
  resolveClientVersion,
  sessionForConversation,
  userAgentFor,
} from '../src/identity.js';

describe('buildIdentityHeaders', () => {
  it('给出闸门要求的身份头，session 四头同值，authorization 使用传入的真实凭据', () => {
    const session = createSessionId();
    const headers = buildIdentityHeaders({
      version: '2.0.24',
      apiKey: 'sk-test',
      session,
      requestId: 'msg_0123456789abOPQRSTUVWXYZab',
    });
    for (const name of [
      'user-agent',
      'authorization',
      'x-opencode-client',
      'x-opencode-project',
      'x-opencode-session',
    ]) {
      assert.equal(typeof headers[name], 'string', `缺少 ${name}`);
      assert.notEqual(headers[name], '', `空的 ${name}`);
    }
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers['x-opencode-client'], OPENCODE_CLIENT);
    assert.equal(headers['x-opencode-project'], OPENCODE_PROJECT);
    assert.match(headers['user-agent'], /^opencode\//);
    // session 四头同值（真实客户端形状）
    for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
      assert.equal(headers[name], session, `${name} 必须等于 session`);
    }
  });

  it('禁止携带 x-opencode-request（带上即被闸门拒绝）', () => {
    const headers = buildIdentityHeaders({
      version: '2.0.24', apiKey: 'sk-test', session: createSessionId(),
      requestId: 'msg_0123456789abOPQRSTUVWXYZab',
    });
    assert.equal(headers['x-opencode-request'], undefined);
  });

  it('没有凭据时退化为匿名凭据（当前闸门会拒绝，仅用于诊断可读的失败）', () => {
    const headers = buildIdentityHeaders({ version: '2.0.24', session: 'ses_a', requestId: 'msg_a' });
    assert.equal(headers.authorization, PUBLIC_AUTHORIZATION);
  });

  it('不发 dsh 的 attribution UA', () => {
    const headers = buildIdentityHeaders({ version: '2.0.24', session: 'ses_a', requestId: 'msg_a' });
    assert.doesNotMatch(headers['user-agent'], /deepseek-harness/);
  });
});

describe('版本门槛', () => {
  it('接受门槛下界并渲染成四段式 UA', () => {
    const resolved = resolveClientVersion('1.18.0');
    assert.equal(resolved.usedFallback, false);
    assert.equal(resolved.version, '1.18.0');
    assert.equal(userAgentFor(resolved.version), 'opencode/latest/1.18.0/cli');
    const headers = buildIdentityHeaders({ version: resolved.version, session: 'ses_a', requestId: 'msg_a' });
    assert.equal(headers['user-agent'], 'opencode/latest/1.18.0/cli');
  });

  it('低于门槛时不使用该值，改为记录诊断并回退到门槛值', () => {
    const resolved = resolveClientVersion('1.17.0');
    assert.equal(resolved.usedFallback, true);
    assert.equal(resolved.version, MIN_CLIENT_VERSION);
    assert.match(resolved.reason, /1\.17\.0/);
    const headers = buildIdentityHeaders({ version: resolved.version, session: 'ses_a', requestId: 'msg_a' });
    assert.notEqual(headers['user-agent'], 'opencode/latest/1.17.0/cli');
    assert.equal(headers['user-agent'], `opencode/latest/${MIN_CLIENT_VERSION}/cli`);
  });

  it('无法解析的版本也回退', () => {
    assert.equal(resolveClientVersion('not-a-version').version, MIN_CLIENT_VERSION);
  });

  it('parseVersion / compareVersions', () => {
    assert.deepEqual(parseVersion('v1.18.31'), [1, 18, 31]);
    assert.deepEqual(parseVersion('1.18'), [1, 18, 0]);
    assert.equal(parseVersion('nope'), undefined);
    assert.ok(compareVersions([1, 18, 0], [1, 17, 9]) > 0);
    assert.equal(compareVersions([1, 18, 0], [1, 18, 0]), 0);
  });
});

describe('会话 id 派生', () => {
  it('官方算法生成的 session 形状正确，且按 48 位截断语义可往返解码', () => {
    const timestamp = 1_792_000_000_000n;
    const session = createSessionId(Number(timestamp));
    assert.match(session, SESSION_PATTERN);
    assert.equal(session.length, 4 + 12 + 14);
    // 实现把 时间戳*0x1000+计数器 截断到 48 位后取反；解码应还原出截断后的值。
    const encoded = BigInt(`0x${session.slice(4, 16)}`);
    const current = ~encoded & 0xffffffffffffn;
    const expected = (timestamp * 0x1000n + 1n) & 0xffffffffffffn;
    assert.equal(current, expected);
  });

  it('同一对话两次派生相等，不同对话不相等', () => {
    const first = sessionForConversation('session-abc');
    const second = sessionForConversation('session-abc');
    const other = sessionForConversation('session-xyz');
    assert.equal(first, second);
    assert.notEqual(first, other);
  });

  it('派生的会话解码值与当前时间一致（闸门要求官方算法的新鲜时间戳）', () => {
    const session = sessionForConversation('freshness-check');
    const decoded = ~BigInt(`0x${session.slice(4, 16)}`) & 0xffffffffffffn;
    const expected = (BigInt(Date.now()) * 0x1000n + 1n) & 0xffffffffffffn;
    const drift = expected > decoded ? expected - decoded : decoded - expected;
    assert.ok(drift < 60_000n * 0x1000n, `解码值偏差 ${drift} 超出 60s 步进`);
  });

  it('请求 id 形状为 msg_ + 12 位十六进制 + 14 位 base62，且按会话与轮次变化', () => {
    const session = sessionForConversation('session-abc');
    const first = requestForTurn(session, 'turn-1');
    assert.match(first, REQUEST_PATTERN);
    assert.equal(requestForTurn(session, 'turn-1'), first);
    assert.notEqual(requestForTurn(session, 'turn-2'), first);
  });

  it('探测会话每次都是新会话，且不与对话会话相同', () => {
    const probe = probeSession();
    assert.match(probe, SESSION_PATTERN);
    assert.notEqual(probe, sessionForConversation('session-abc'));
    assert.notEqual(probeSession(), probe);
    assert.match(probeRequest('round-1', 'fledge-alpha-free'), REQUEST_PATTERN);
    assert.notEqual(probeRequest('round-1', 'a-free'), probeRequest('round-1', 'b-free'));
  });

  it('空对话标识退化为全局会话而不是随机值', () => {
    assert.equal(sessionForConversation(undefined), sessionForConversation(''));
  });
});
