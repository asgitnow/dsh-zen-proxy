/**
 * zen-region-relay — 区域受限免费模型的中继 Worker。
 *
 * 部署在非受限出口（Cloudflare 边缘）上，把 dsh-zen-proxy 的免费车道请求原样转发给
 * opencode.ai，使被出口国家拦截的模型（`RegionError`）恢复可用。响应（含 SSE 流）
 * 逐字节透传，不做任何改写。
 *
 * 授权（必须）：部署时 `npx wrangler secret put RELAY_TOKEN` 设置令牌；调用方在
 * `x-zen-relay-token` 头（或 `?token=` 查询参数）里给出相同值。令牌未设置时 Worker
 * 拒绝一切请求（fail closed），避免成为裸奔代理。
 *
 * 只放行免费车道实际用到的三个路径，最小化滥用面。
 */

const UPSTREAM = 'https://opencode.ai/zen/v1';

const ALLOWED_PATHS = new Set(['/models', '/chat/completions', '/responses']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: { type: 'api_error', message: 'relay: method not allowed' } }, 405);
    }
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return json({ error: { type: 'api_error', message: 'relay: unknown path' } }, 404);
    }

    // ── 授权：与部署侧 RELAY_TOKEN 精确匹配（常数时间比较） ─────────────────────
    const expected = typeof env?.RELAY_TOKEN === 'string' ? env.RELAY_TOKEN : '';
    if (expected === '') {
      return json(
        { error: { type: 'api_error', message: 'relay is not configured: set the RELAY_TOKEN secret (wrangler secret put RELAY_TOKEN)' } },
        503,
      );
    }
    const got = request.headers.get('x-zen-relay-token') ?? url.searchParams.get('token') ?? '';
    if (!tokensEqual(got, expected)) {
      return json({ error: { type: 'api_error', message: 'relay: token mismatch' } }, 403);
    }

    // ── 透传：方法 / 路径 / 查询 / 头（剥离中继令牌与逐跳头）/ 体 / SSE 流 ──────────
    const upstream = new URL(UPSTREAM + url.pathname);
    upstream.search = url.search;
    const headers = new Headers(request.headers);
    headers.delete('x-zen-relay-token');
    headers.delete('host');
    headers.delete('content-length');
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
      // 双工流：请求体是流时（SSE 请求体通常不是）仍允许边读边写
      duplex: 'half',
      redirect: 'manual',
    }).catch(() => undefined);
    if (response === undefined) {
      return json({ error: { type: 'api_error', message: 'relay: upstream unreachable' } }, 502);
    }

    const out = new Headers(response.headers);
    out.delete('set-cookie');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    });
  },
};

function json(body, status) {
  return Response.json(body, { status });
}

/**
 * 常数时间令牌比较：对两侧各取一次 SHA-256 再逐字节比较，长度差异也不提前返回。
 * @param {string} got
 * @param {string} expected
 * @returns {boolean}
 */
async function tokensEqual(got, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(got)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index % b.length];
  }
  return diff === 0;
}
