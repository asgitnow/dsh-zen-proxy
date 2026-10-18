/**
 * `src/state.js`：目录的持久化——上游清单里最近一次看到的免费模型 id 列表。
 *
 * 目录不做可用性判定（探测在免费车道上自耗配额），因此本文件只验证：
 * 形状归一、v1 判定状态的迁移、原子保存与缺失容错。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  STATE_VERSION,
  emptyState,
  loadState,
  resolveStateDir,
  resolveStateFile,
  saveState,
} from '../src/state.js';

const TMP = mkdtempSync(join(tmpdir(), 'zen-state-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('src/state.js', () => {
  describe('路径解析', () => {
    it('默认 <home>/.dsh/zen-proxy/availability.json，DSH_HOME 优先', () => {
      const env = { DSH_HOME: join(TMP, 'dsh-home') };
      assert.equal(
        resolveStateFile({ env }),
        join(TMP, 'dsh-home', 'zen-proxy', 'availability.json'),
      );
      assert.equal(resolveStateDir({ env }), join(TMP, 'dsh-home', 'zen-proxy'));
      const home = join(TMP, 'plain-home');
      assert.equal(
        resolveStateFile({ env: {}, home }),
        join(home, '.dsh', 'zen-proxy', 'availability.json'),
      );
    });
  });

  describe('目录形状', () => {
    it('空状态：version 2、models 为空数组', () => {
      const state = emptyState();
      assert.equal(state.version, STATE_VERSION);
      assert.equal(state.version, 2);
      assert.deepEqual(state.models, []);
      assert.equal(state.updatedAt, 0);
    });

    it('保存后读回：id 列表原样', () => {
      const file = join(TMP, 'roundtrip.json');
      const state = { version: STATE_VERSION, updatedAt: 42, models: ['a-free', 'b-free'] };
      assert.equal(saveState(file, state), true);
      const loaded = loadState(file);
      assert.deepEqual(loaded.models, ['a-free', 'b-free']);
      assert.equal(loaded.updatedAt, 42);
      assert.equal(loaded.version, STATE_VERSION);
    });

    it('保存用临时文件原子改名，不残留 .tmp', () => {
      const file = join(TMP, 'atomic.json');
      saveState(file, { version: STATE_VERSION, updatedAt: 1, models: ['x-free'] });
      const leftovers = readdirSync(TMP).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
      assert.match(readFileSync(file, 'utf8'), /\n$/);
    });

    it('文件缺失 / 非法 JSON / 非对象 → 空状态，不抛', () => {
      assert.deepEqual(loadState(join(TMP, 'nope.json')), emptyState());
      const broken = join(TMP, 'broken.json');
      writeFileSync(broken, '{not json');
      assert.deepEqual(loadState(broken), emptyState());
      const notObject = join(TMP, 'array.json');
      writeFileSync(notObject, '[1,2]');
      assert.deepEqual(loadState(notObject), emptyState());
    });

    it('models 含非字符串或空串项时被过滤，重复项去重', () => {
      const file = join(TMP, 'dirty.json');
      writeFileSync(file, JSON.stringify({
        version: 2, updatedAt: 7, models: ['a-free', '', 3, 'a-free', 'b-free'],
      }));
      assert.deepEqual(loadState(file).models, ['a-free', 'b-free']);
    });

    it('v1 判定状态迁移：钥匙即 id 列表（重启后目录不空）', () => {
      const file = join(TMP, 'v1.json');
      writeFileSync(file, JSON.stringify({
        version: 1,
        updatedAt: 1792290342769,
        models: {
          'beam-free': { state: 'region', transientStreak: 1 },
          'mimo-v2.6-flash-free': { state: 'unknown', transientStreak: 2 },
        },
      }));
      const loaded = loadState(file);
      assert.equal(loaded.version, STATE_VERSION);
      assert.equal(loaded.updatedAt, 1792290342769);
      assert.deepEqual(loaded.models, ['beam-free', 'mimo-v2.6-flash-free']);
    });
  });
});
