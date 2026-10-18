/**
 * 凭据解析：免费车道闸门拒绝匿名流量，请求必须携带真实凭据。按优先级：
 *
 * 1. 插件配置 `config.apiKey`（显式给出，最高）；
 * 2. 环境变量 `OPENCODE_API_KEY`；
 * 3. opencode 凭据库 `opencode.db` 的 `credential` 表——新版 opencode（设备码登录）把
 *    凭据存在 SQLite：oauth 存 `access` token，服务账号存 `key`。重新登录或令牌轮换
 *    后该表自动更新（见 opencode 源码 `packages/core/src/plugin/provider/opencode.ts`：
 *    推理请求就是把 oauth `access` 直接当 provider 的 `apiKey` 发 `Bearer`）；
 * 4. 旧版 opencode 的 `auth.json` 里的 `opencode.key`（老安装残留，兼容读）。
 *
 * **每次调用都现读，不做任何缓存**：换号重登后下一轮探测（乃至下一个请求）即生效，
 * 无需重启宿主。SQLite 只读打开，与正在运行的 opencode 共存无冲突（WAL 模式）。
 *
 * 本模块是宿主无关的：只依赖 node:fs / node:path / node:sqlite（动态加载）。
 *
 * @module src/credentials.js
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * opencode 数据目录：`auth.json` 与 `opencode.db` 的共同父目录。
 * 官方用 XDG 布局：`$XDG_DATA_HOME/opencode`，Windows 与默认回退都是
 * `~/.local/share/opencode`。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {string | undefined}
 */
function opencodeDataDir(env = process.env) {
  const xdg = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME.trim()
    : undefined;
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() !== ''
    ? env.USERPROFILE
    : env.HOME;
  if (xdg !== undefined) return join(xdg, 'opencode');
  if (typeof home === 'string' && home !== '') return join(home, '.local', 'share', 'opencode');
  return undefined;
}

/**
 * 旧版 opencode 的 `auth.json` 路径。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {string | undefined}
 */
export function opencodeAuthFile(env = process.env) {
  const dir = opencodeDataDir(env);
  return dir === undefined ? undefined : join(dir, 'auth.json');
}

/**
 * 新版 opencode 的凭据库路径（`opencode.db`）。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {string | undefined}
 */
export function opencodeDbFile(env = process.env) {
  const dir = opencodeDataDir(env);
  return dir === undefined ? undefined : join(dir, 'opencode.db');
}

/**
 * 从旧版 `auth.json` 里读 `opencode.key`。文件缺失、损坏或没有该条目时
 * 返回 undefined，绝不抛出。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {string | undefined}
 */
export function readOpencodeAuthKey(env = process.env) {
  const file = opencodeAuthFile(env);
  if (file === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const entry = parsed?.opencode;
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    return key === '' ? undefined : key;
  } catch {
    return undefined;
  }
}

// node:sqlite 的模块引用（缓存的是模块加载结果，不是数据；宿主运行时缺它时置 null）。
let sqliteModule;
async function loadSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/**
 * 从 opencode.db 的 `credential` 表读 integration_id='opencode' 的当前凭据，
 * 归一成 bearer 字符串：oauth → `access`，key → `key`。
 * 库不存在、表不存在、行损坏、运行时没有 node:sqlite——一律返回 undefined，
 * 让解析落到下一优先级（auth.json），不抛错。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {Promise<string | undefined>}
 */
export async function readOpencodeStoredKey(env = process.env) {
  const file = opencodeDbFile(env);
  if (file === undefined) return undefined;
  const mod = await loadSqlite();
  if (mod === null) return undefined;
  try {
    const db = new mod.DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT value, active FROM credential WHERE integration_id = 'opencode'",
      ).all();
      const row = rows.find((r) => r.active === 1) ?? rows[0];
      if (row === undefined) return undefined;
      const parsed = JSON.parse(String(row.value));
      const key = parsed?.type === 'oauth' ? parsed.access
        : parsed?.type === 'key' ? parsed.key
        : undefined;
      return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * 解析免费车道凭据。每次调用现读，无缓存。
 * @param {{explicit?: string, env?: object}} [options]
 *   `explicit` 是插件配置里的 `apiKey`（最高优先级，空串视为未配置）
 * @returns {Promise<string | undefined>} 可用的 API key，找不到时 undefined
 */
export async function resolveApiKey({ explicit, env = process.env } = {}) {
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  if (trimmed !== '') return trimmed;
  const fromEnv = typeof env.OPENCODE_API_KEY === 'string' ? env.OPENCODE_API_KEY.trim() : '';
  if (fromEnv !== '') return fromEnv;
  return (await readOpencodeStoredKey(env)) ?? readOpencodeAuthKey(env);
}
