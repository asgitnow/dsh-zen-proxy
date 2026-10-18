/**
 * 目录的持久化：上游清单里最近一次看到的免费模型 id 列表。
 *
 * 目录**不做可用性判定**——探测在这条车道上是自毁的：免费配额按会话计，周期探测
 * 每 10 分钟新开 9 个会话，把自己打到 429 限流，再经宽限折算把模型压出目录。
 * 目录只回答「上游有什么」；模型失败不失败由请求路径自己暴露给用户。
 *
 * 形状：`{ version: 2, updatedAt: epoch-ms, models: string[] }`。持久化用
 * 「先写临时文件再原子改名」；文件缺失或不可解析时按无历史处理且不抛错。
 * v1 的判定状态在读取时迁移为 id 列表（钥匙即 id），让重启后的短暂窗口里目录不空。
 *
 * 状态目录从宿主环境解析（`DSH_HOME` → 宿主配置根），**不写死**任何用户目录路径。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/state.js
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

/** 状态文件结构版本；形状或含义变化时递增。 */
export const STATE_VERSION = 2;

/** 状态目录名（相对宿主配置根）。 */
export const DATA_DIR_NAME = 'zen-proxy';

/** 状态文件名。 */
export const STATE_FILE_NAME = 'availability.json';

/**
 * 空状态：目录为空，等待首轮清单填充。
 * @returns {object}
 */
export function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, models: [] };
}

/**
 * 把持久化的任意 JSON 归一成当前形状；认不出时返回 `undefined`（按无历史处理）。
 * @param {unknown} parsed
 * @returns {object | undefined}
 */
function normalizeState(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const updatedAt = Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt : 0;
  if (Array.isArray(parsed.models)) {
    const models = [];
    const seen = new Set();
    for (const id of parsed.models) {
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    return { version: STATE_VERSION, updatedAt, models };
  }
  // v1 迁移：判定状态对象的钥匙就是模型 id。
  if (parsed.models !== null && typeof parsed.models === 'object') {
    return { version: STATE_VERSION, updatedAt, models: Object.keys(parsed.models) };
  }
  return undefined;
}

/**
 * 解析状态目录：`DSH_HOME` → 宿主配置根（`<home>/.dsh`），再拼上 {@link DATA_DIR_NAME}。
 * @param {{env?: Record<string, string | undefined>, home?: string}} [input]
 * @returns {string}
 */
export function resolveStateDir({ env = {}, home } = {}) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const base = home !== undefined && home !== '' ? home : os.homedir();
  const root = fromEnv !== '' ? fromEnv : join(base, '.dsh');
  return join(root, DATA_DIR_NAME);
}

/**
 * 状态文件的完整路径。
 * @param {{env?: Record<string, string | undefined>, home?: string, stateDir?: string}} [input]
 * @returns {string}
 */
export function resolveStateFile(input = {}) {
  const dir = input.stateDir !== undefined && input.stateDir !== ''
    ? input.stateDir
    : resolveStateDir(input);
  return join(dir, STATE_FILE_NAME);
}

/**
 * 读取状态文件；缺失、被截断或含非法 JSON 时按无历史处理。
 * @param {string} filePath
 * @returns {object} 状态对象，永不抛错
 */
export function loadState(filePath) {
  try {
    return normalizeState(JSON.parse(readFileSync(filePath, 'utf8'))) ?? emptyState();
  } catch {
    return emptyState();
  }
}

/**
 * 原子保存状态：先写临时文件再改名，避免读到半份文件。
 * @param {string} filePath
 * @param {object} state
 * @returns {boolean} 写入成功为 `true`
 */
export function saveState(filePath, state) {
  const temporary = `${filePath}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(temporary, filePath);
    return true;
  } catch {
    return false;
  }
}
