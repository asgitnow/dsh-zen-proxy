/**
 * 开发时取值：从 models.dev 取 opencode provider 的 limit.context / limit.output / modalities，
 * 覆盖**上游当前列出的全部免费模型**（不再硬编码 id 列表，以免与上游漂移脱节）。
 *
 * 运行时插件同样会请求该地址（见 `src/catalog.js` 的 `loadCapabilities`），本脚本用于
 * 人工核对那份响应里的字段，以及排查某个模型为何被声明成纯文本。
 */
const FREE_SUFFIX = '-free';

const listing = await (await fetch('https://opencode.ai/zen/v1/models', { signal: AbortSignal.timeout(30000) })).json();
const upstream = (listing.data ?? []).map((m) => m.id);
const freeIds = upstream.filter((id) => id.endsWith(FREE_SUFFIX)).sort();

const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(60000) });
console.log(`GET https://models.dev/api.json -> ${res.status} ${res.headers.get('last-modified') ?? ''}`);
const data = await res.json();
const opencode = data?.opencode ?? data?.providers?.opencode;
const models = opencode?.models ?? {};
console.log(`opencode provider models: ${Object.keys(models).length}`);
console.log(`上游清单模型数: ${upstream.length}，其中 -free 结尾: ${freeIds.length}\n`);

for (const id of freeIds) {
  const row = models[id];
  if (row === undefined) {
    console.log(`${id.padEnd(34)} ABSENT（models.dev 无此条目）`);
    continue;
  }
  const img = row.modalities?.input?.includes('image') === true;
  console.log(
    `${id.padEnd(34)} context=${String(row.limit?.context ?? '-').padStart(8)}`
    + ` output=${String(row.limit?.output ?? '-').padStart(7)}`
    + ` reasoning=${String(row.reasoning ?? '-').padStart(5)}`
    + ` image=${String(img).padStart(5)}`
    + ` in=[${(row.modalities?.input ?? []).join(',')}]`
    + ` name=${row.name ?? '-'}`,
  );
}

