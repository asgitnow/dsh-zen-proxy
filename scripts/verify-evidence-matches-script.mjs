/**
 * N1 的终极验收（第二版，修 D2 的盲区）：把归档后的 evidence.md 里那段
 * 「三方对照的脚本实际输出汇总段」与 `node scripts/verify-sources.mjs` 的真实 stdout 比对。
 *
 * 第一版只从 `受检模型数` 起比对，因此**结构上无法发现「前置删行」**——而文档当时还写着
 * 「逐字粘贴，未做任何修饰」，等于给了一个比对工具覆盖不到的绝对断言（审查 D2）。
 * 本版做两件事：
 *   1. 把文档块作为**完整 stdout 的连续后缀**来校验（顺序、内容都要对得上）；
 *   2. 读出文档里声明的「省略了 stdout 开头的 N 行」，与实际省略行数比对——声明与实际必须相符。
 * 这样「偷偷删行」会同时打破第 1 或第 2 条，无法再蒙混。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/，被调用的 verify-sources.mjs 是它的同目录邻居。
const SCRIPTS = import.meta.dirname;
const REPO = join(SCRIPTS, '..');
const EV = join(REPO, 'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/evidence.md');

const raw = execFileSync(process.execPath, [join(SCRIPTS, 'verify-sources.mjs')], {
  encoding: 'utf8',
});
if (!raw.includes('受检模型数')) throw new Error('脚本输出里找不到「受检模型数」，汇总格式变了');

const rawLines = raw.replace(/\r/g, '').split('\n');
// 去掉末尾空行，得到有效 stdout 行
while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();

const text = readFileSync(EV, 'utf8');
// 带位置匹配，才能把「声明」限定到所选块**前面的那段散文**里。
const allBlocks = [...text.matchAll(/```text\r?\n([\s\S]*?)```/g)];
// 2026-10-17：文档里现在有**两个**含「受检模型数」的块——(2) 是 2026-10-08 的历史记录
// （三方对照口径，已标注不可用当前脚本复现），(2c) 是当前口径（两方对照）的逐字全文。
// 必须取**最后一个**（即最新口径），否则会拿历史块去对当前 stdout，恒判不符。
const candidates = allBlocks.filter((m) => m[1].includes('受检模型数'));
if (candidates.length === 0) throw new Error('evidence.md 里找不到含「受检模型数」的 text 代码块');
const chosen = candidates[candidates.length - 1];
const docBlock = chosen[1];
console.log(`含「受检模型数」的代码块数 = ${candidates.length}（取最后一个作为当前口径）`);

// 声明必须来自**紧邻该块的那一段散文**。不能取「上一个代码块到本块」的整段：
// 那会把中间的勘误段落一并吞进来，而勘误里恰好有「未做任何修饰」这类字样，
// 使 `claimsComplete` 恒为真、完整性检查形同虚设（2026-10-17 自测发现）。
// 取法：本块之前的最后一个非空段落，且不能是代码围栏（```）。
// 注意 CRLF：本文件行尾是 \r\n，用 `\n\s*\n` 分段（\s 含 \r）而不是 `\n[ \t]*\n`，
// 否则一个分段都切不出来、prose 退化成整篇文档（2026-10-17 自测踩到）。
const paras = text.slice(0, chosen.index).split(/\r?\n\s*\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s !== '' && !s.startsWith('```'));
const prose = paras[paras.length - 1] ?? '';
if (prose === '') throw new Error('所选块前面找不到紧邻的散文段，无法判定完整性声明');

const docLines = docBlock.replace(/\r/g, '').split('\n');
while (docLines.length > 0 && docLines[docLines.length - 1].trim() === '') docLines.pop();

console.log(`完整 stdout 有效行数 = ${rawLines.length}`);
console.log(`文档粘贴行数         = ${docLines.length}`);

// --- 检查 1：文档块必须是完整 stdout 的连续后缀 ---
const omitted = rawLines.length - docLines.length;
let suffixOk = omitted >= 0;
if (suffixOk) {
  for (let i = 0; i < docLines.length; i += 1) {
    if (rawLines[omitted + i] !== docLines[i]) { suffixOk = false; break; }
  }
}
console.log(`\n[检查 1] 文档块是 stdout 的连续后缀 = ${suffixOk}（实际省略开头 ${omitted} 行）`);

// --- 检查 2：省略行数的声明必须与实际相符 ---
// 两种正当形状：
//   (a) 有省略 → 散文里必须写明「省略了 stdout 开头的 N 行」，且 N === omitted；
//   (b) 无省略 → 散文里必须**明确声明完整**（「逐字全文」或「未省略」），且不得声明任何省略。
// 「既没声明省略、也没声明完整」= 不可判定，判为失败（默默不做声明是本次要堵的漏洞）。
const omittedMatch = /省略了 stdout 开头的\s*(\d+)\s*行/.exec(prose);
const claimsComplete = /逐字全文|未省略|未做任何修饰|完整粘贴/.test(prose);
const declared = omittedMatch === null ? (claimsComplete ? 0 : null) : Number(omittedMatch[1]);
const omissionOk = declared !== null && declared === omitted;
console.log(`[检查 2] 声明省略行数 = ${declared}（${omittedMatch !== null ? '按省略声明' : claimsComplete ? '按完整声明' : '未声明'}）；实际 = ${omitted}`
  + ` => ${omissionOk ? 'ok 相符' : 'DIFF 不符'}`);

// --- 检查 3：声明了「完整 stdout 共 N 行」时，N 必须等于实际 ---
const totalMatch = /完整 stdout 共\s*(\d+)\s*行/.exec(prose);
const declaredTotal = totalMatch === null ? null : Number(totalMatch[1]);
const totalOk = declaredTotal === null || declaredTotal === rawLines.length;
console.log(`[检查 3] 声明 stdout 总行数 = ${declaredTotal ?? '(未声明)'}；实际 = ${rawLines.length}`
  + ` => ${totalOk ? 'ok 相符' : 'DIFF 不符'}`);

const failures = [suffixOk, omissionOk, totalOk]
  .filter((x) => x !== true).length;
console.log(`\n失败检查数 = ${failures}`);
if (failures === 0) console.log('文档与脚本真实输出一致，且省略/完整性的声明与实际相符。');
process.exitCode = failures === 0 ? 0 : 1;
