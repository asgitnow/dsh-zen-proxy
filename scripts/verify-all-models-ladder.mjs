/**
 * 逐模型核对：档位菜单里的数字 == 该档将发出的预算。
 *
 * 2026-10-17：容量来自运行时拉取的 models.dev（不再是 11 条静态快照），因此本脚本
 * 改为对**全部**免费模型实拉实跑，覆盖面从 11 个扩大到整个免费集合。
 *
 * 动机：既有单测只覆盖 3-4 个模型；本脚本用真实能力表跑全量，确认没有某个模型
 * 因容量极小（例如容量 < light 档的 4096）而出现「名称与预算不一致」、
 * 「deep 档反而小于 balanced 档」，或菜单数字荒谬。
 */
import { budgetFor, effortsFor, ALWAYS_THINKING_FACTOR } from '../src/effort.js';
import { loadCapabilities, outputLimitFor } from '../src/catalog.js';

const ok = await loadCapabilities({});
if (ok === undefined) {
  throw new Error('能力表拉取失败：本脚本必须基于实时 models.dev 数据运行，不得在拉取失败时输出任何「通过」。');
}

const ids = Object.keys(ok).filter((id) => id.endsWith('-free')).sort();
console.log(`受检模型数 = ${ids.length}（全部免费模型）\n`);
console.log('模型'.padEnd(34) + '容量'.padStart(9) + '  light'.padStart(8) + '  balanced'.padStart(10) + '  deep'.padStart(9) + '  菜单');
console.log('-'.repeat(112));

let problems = 0;
for (const id of ids) {
  const model = { outputLimit: outputLimitFor(id) };
  const cap = outputLimitFor(id);
  const light = budgetFor('light', model, undefined);
  const balanced = budgetFor('balanced', model, undefined);
  const deep = budgetFor('deep', model, undefined);
  const names = effortsFor(model);
  const menu = names.map((e) => e.name).join(' | ');

  // 逐档核对：名称里的 K 数 == 预算/1024 四舍五入
  const kilosOk = names.every((e, i) => {
    const budget = [light, balanced, deep][i];
    return e.name.includes(Math.round(budget / 1024) + ' K');
  });
  // 单调性：light <= balanced <= deep（档位越高天花板不应更低）
  const monotone = light <= balanced && balanced <= deep;
  if (!kilosOk || !monotone) problems += 1;

  console.log(
    id.padEnd(34)
    + String(cap).padStart(9)
    + String(light).padStart(8)
    + String(balanced).padStart(10)
    + String(deep).padStart(9)
    + '  ' + (kilosOk ? 'k-ok' : 'K-BAD') + (monotone ? ' mono-ok' : ' MONO-BAD'),
  );
}

console.log('-'.repeat(112));
console.log(`\n名称与预算不一致 或 档位非单调 的模型数 = ${problems}`);
console.log(`倍率 = ${ALWAYS_THINKING_FACTOR}；light/balanced 理论值 = ${2048 * ALWAYS_THINKING_FACTOR}/${8192 * ALWAYS_THINKING_FACTOR}`);
console.log('\n菜单样例（mimo-v2.6-flash-free）:', effortsFor({ outputLimit: outputLimitFor('mimo-v2.6-flash-free') }).map((e) => e.name).join(' | '));
process.exitCode = problems === 0 ? 0 : 1;
