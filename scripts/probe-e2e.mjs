/**
 * 端到端验证：能力表透传 + 图片真发到上游。
 *
 * 不 mock 任何东西：真实拉取 models.dev、真实读 opencode 凭据、真实发送图片。
 * 验证三点：
 *   1. 能力表能拉到，且 contextWindow / outputLimit / inputModalities 按 id 透传；
 *   2. 图片经 `chatMessages` 转成上游接受的 `image_url` 形状；
 *   3. 上游确实看懂图片（模型描述出图片内容）。
 *
 * 用法：PROBE_PNG=<base64 文件> node scripts/probe-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCapabilities, capabilityOf, contextWindowFor, outputLimitFor, inputModalitiesFor } from '../src/catalog.js';
import { buildIdentityHeaders, deriveId, probeSession, resolveClientVersion } from '../src/identity.js';
import { buildRequestFor } from '../src/messages.js';
import { applyToolQuartet } from '../src/tools.js';
import { UPSTREAM_BASE_URL, CHAT_COMPLETIONS_PATH } from '../src/catalog.js';

const MODEL = process.argv[2] ?? 'nemotron-3.5-super-vl-free';
const PNG_PATH = process.env.PROBE_PNG ?? join(process.env.TEMP ?? '/tmp', 'testimg', 'green.b64');
const PNG = readFileSync(PNG_PATH, 'utf8').trim();
const KEY = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.local', 'share', 'opencode', 'auth.json'), 'utf8')).opencode.key;
const { version } = resolveClientVersion();

// ── 1. 能力表透传 ────────────────────────────────────────────────────────────
console.log('=== 1) 能力表（真实拉取 models.dev）===');
const ok = await loadCapabilities({});
console.log('拉取结果:', ok !== undefined ? '成功' : '失败');
console.log(`  ${MODEL}`);
console.log('    contextWindow  =', contextWindowFor(MODEL));
console.log('    outputLimit    =', outputLimitFor(MODEL));
console.log('    inputModalities=', JSON.stringify(inputModalitiesFor(MODEL)));
console.log('    capability 里的 limit/modalities:', JSON.stringify(capabilityOf(MODEL)?.limit), JSON.stringify(capabilityOf(MODEL)?.modalities));

// ── 2. 构造带图片的请求体（走真实的 buildRequestFor + chatMessages）──────────
console.log('\n=== 2) 请求体（真实 images Map）===');
const images = new Map([['sha256:probe', `data:image/png;base64,${PNG}`]]);
const messages = [{
  role: 'user',
  content: [
    { type: 'text', text: 'what color is the background of this image? answer with the color name only.' },
    { type: 'image', attachment: { attachmentId: 'sha256:probe', mediaType: 'image/png', bytes: 100, width: 512, height: 512 } },
  ],
}];
const { tools } = applyToolQuartet([], { style: 'chat', toolChoice: false });
const body = buildRequestFor('chat', { model: MODEL, messages, tools, images, maxTokens: 512 });
const userMsg = body.messages.find((m) => m.role === 'user');
console.log('user content 形状:', Array.isArray(userMsg.content)
  ? userMsg.content.map((p) => p.type).join(' + ')
  : '(纯字符串)');
const imgPart = Array.isArray(userMsg.content) ? userMsg.content.find((p) => p.type === 'image_url') : undefined;
console.log('image_url 前缀:', imgPart?.image_url?.url?.slice(0, 40) + '…');

// ── 3. 真实发送 ──────────────────────────────────────────────────────────────
console.log('\n=== 3) 发给上游 ===');
const session = probeSession();
const headers = buildIdentityHeaders({ version, session, requestId: deriveId('msg_', 'e2e' + session), stream: true, apiKey: KEY });
const res = await fetch(`${UPSTREAM_BASE_URL}${CHAT_COMPLETIONS_PATH}`, {
  method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
});
console.log('HTTP', res.status);
if (!res.ok) { console.log((await res.text()).replace(/\s+/g, ' ').slice(0, 300)); process.exit(1); }

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '', text = '', think = '', err = null;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let cut;
  while ((cut = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '' || p === '[DONE]') continue;
      try {
        const j = JSON.parse(p);
        if (j.error) err = JSON.stringify(j.error);
        const d = j?.choices?.[0]?.delta;
        if (typeof d?.content === 'string') text += d.content;
        if (typeof d?.reasoning_content === 'string') think += d.reasoning_content;
      } catch { /* 非 JSON 帧 */ }
    }
  }
}
await reader.cancel().catch(() => {});
if (err !== null) { console.log('流内错误:', err); process.exit(1); }
console.log('正文:', JSON.stringify(text.slice(0, 200)));
console.log('思考尾:', JSON.stringify(think.slice(-200)));
const saw = /green/i.test(text) || /green/i.test(think);
console.log('\n结论:', saw ? '✅ 模型读到了图片内容（提到 green）' : '⚠️ 未见 green，检查图片或模型');
