/**
 * 凭据解析：免费车道闸门已拒绝匿名流量（`Bearer public` 恒定 403），请求必须携带
 * 真实 API key。按优先级解析：
 *
 * 1. 插件配置里显式给出的 key（`config.apiKey`，由调用方传入）；
 * 2. 环境变量 `OPENCODE_API_KEY`（与官方客户端同名约定）；
 * 3. opencode 客户端的凭据存储 `auth.json` 里的 `opencode.key`——本机装过
 *    `@opencode/cli` 并登录过 Console 时自然存在，无需重复配置。
 *
 * 解析结果按进程缓存；`auth.json` 变更（重新登录）会在下次进程启动后生效。
 * 本模块是宿主无关的：只依赖 node:fs / node:path，不 import 任何 `@deepseek-ai/*`。
 *
 * @module src/credentials.js
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 解析结果缓存：undefined = 尚未解析，null = 已解析且无 key。 */
let cached;

/**
 * opencode 客户端的 `auth.json` 路径。官方客户端用 XDG 布局：
 * `$XDG_DATA_HOME/opencode/auth.json`，Windows 与默认回退都是
 * `~/.local/share/opencode/auth.json`。
 * @param {object} [env] 环境变量，默认 `process.env`
 * @returns {string | undefined}
 */
export function opencodeAuthFile(env = process.env) {
  const xdg = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME.trim()
    : undefined;
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() !== ''
    ? env.USERPROFILE
    : env.HOME;
  if (xdg !== undefined) return join(xdg, 'opencode', 'auth.json');
  if (typeof home === 'string' && home !== '') return join(home, '.local', 'share', 'opencode', 'auth.json');
  return undefined;
}

/**
 * 从 opencode 的 `auth.json` 里读 `opencode.key`。文件缺失、损坏或没有该条目时
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

/**
 * 解析免费车道凭据。
 * @param {{explicit?: string, env?: object}} [options]
 *   `explicit` 是插件配置里的 `apiKey`（最高优先级，空串视为未配置）
 * @returns {string | undefined} 可用的 API key，找不到时 undefined
 */
export function resolveApiKey({ explicit, env = process.env } = {}) {
  const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
  if (trimmed !== '') return trimmed;
  const fromEnv = typeof env.OPENCODE_API_KEY === 'string' ? env.OPENCODE_API_KEY.trim() : '';
  if (fromEnv !== '') return fromEnv;
  if (cached === undefined) cached = readOpencodeAuthKey(env) ?? null;
  return cached ?? undefined;
}

/** 清空解析缓存（测试用；生产路径无需调用）。 */
export function resetCredentialCache() {
  cached = undefined;
}
