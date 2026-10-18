/**
 * `src/credentials.js`：凭据解析的优先级与「现读」语义。
 *
 * 关键行为：每次 `resolveApiKey` 都现读凭据源，不做任何进程缓存——opencode 里
 * 换号重登（新版写入 `opencode.db` 的 `credential` 表）或改配置后，下一次解析
 * 就能拿到新值。本文件用临时目录 + 真实 node:sqlite 建库验证这条链路。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  opencodeAuthFile,
  opencodeDbFile,
  readOpencodeAuthKey,
  readOpencodeStoredKey,
  resolveApiKey,
} from '../src/credentials.js';

const TMP = mkdtempSync(join(tmpdir(), 'zen-cred-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** 建一个带 credential 表的最小 opencode.db。 */
function seedDb(dir, rows) {
  mkdirSync(join(dir, 'opencode'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode', 'opencode.db'));
  db.exec('CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER)');
  for (const [integration, value, active] of rows) {
    db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run('cred-x', integration, value, active);
  }
  db.close();
}

/** 旧版 auth.json。 */
function seedAuth(dir, key) {
  mkdirSync(join(dir, 'opencode'), { recursive: true });
  writeFileSync(join(dir, 'opencode', 'auth.json'), JSON.stringify({ opencode: { key } }));
}

const OAUTH_VALUE = JSON.stringify({
  type: 'oauth', methodID: 'device', access: 'st-new', refresh: 'rt-x',
  expires: Date.now() + 86_400_000, metadata: { server: 'https://opencode.ai/console' },
});
const KEY_VALUE = JSON.stringify({ type: 'key', key: 'sk-svc' });

describe('src/credentials.js', () => {
  describe('路径解析', () => {
    it('默认回退 ~/.local/share/opencode（USERPROFILE / HOME）', () => {
      const dir = join(TMP, 'path-home');
      const home = join(dir, 'home');
      const env = { USERPROFILE: home, HOME: home };
      assert.equal(opencodeAuthFile(env), join(home, '.local', 'share', 'opencode', 'auth.json'));
      assert.equal(opencodeDbFile(env), join(home, '.local', 'share', 'opencode', 'opencode.db'));
    });

    it('XDG_DATA_HOME 优先', () => {
      const env = { XDG_DATA_HOME: join(TMP, 'xdg'), USERPROFILE: join(TMP, 'home') };
      assert.equal(opencodeDbFile(env), join(TMP, 'xdg', 'opencode', 'opencode.db'));
    });
  });

  describe('opencode.db（新版凭据库）', () => {
    it('oauth 凭据取 access 字段', async () => {
      const dir = join(TMP, 'db-oauth');
      seedDb(dir, [['opencode', OAUTH_VALUE, 1]]);
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: dir }), 'st-new');
    });

    it('key 凭据取 key 字段', async () => {
      const dir = join(TMP, 'db-key');
      seedDb(dir, [['opencode', KEY_VALUE, 1]]);
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: dir }), 'sk-svc');
    });

    it('多行时取 active=1 的行', async () => {
      const dir = join(TMP, 'db-active');
      seedDb(dir, [
        ['opencode', OAUTH_VALUE, 0],
        ['opencode', JSON.stringify({ type: 'oauth', access: 'st-active', refresh: 'rt' }), 1],
      ]);
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: dir }), 'st-active');
    });

    it('**现读**：行内值更新后立即读到新值（无进程缓存）', async () => {
      const dir = join(TMP, 'db-fresh');
      seedDb(dir, [['opencode', OAUTH_VALUE, 1]]);
      const env = { XDG_DATA_HOME: dir };
      assert.equal(await readOpencodeStoredKey(env), 'st-new');

      // 模拟 opencode 令牌轮换 / 换号重登：改写同一行。
      const db = new DatabaseSync(join(dir, 'opencode', 'opencode.db'));
      db.prepare("UPDATE credential SET value = ? WHERE integration_id = 'opencode'")
        .run(JSON.stringify({ type: 'oauth', access: 'st-rotated', refresh: 'rt' }));
      db.close();
      assert.equal(await readOpencodeStoredKey(env), 'st-rotated');
    });

    it('库缺失 / 行损坏 / 无行 → undefined，不抛', async () => {
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: join(TMP, 'nope') }), undefined);
      const broken = join(TMP, 'db-broken');
      mkdirSync(join(broken, 'opencode'), { recursive: true });
      writeFileSync(join(broken, 'opencode', 'opencode.db'), 'not a database');
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: broken }), undefined);
      const empty = join(TMP, 'db-empty');
      seedDb(empty, []);
      assert.equal(await readOpencodeStoredKey({ XDG_DATA_HOME: empty }), undefined);
    });
  });

  describe('旧版 auth.json 兼容', () => {
    it('读到 opencode.key', () => {
      const dir = join(TMP, 'auth-legacy');
      seedAuth(dir, 'sk-legacy');
      assert.equal(readOpencodeAuthKey({ XDG_DATA_HOME: dir }), 'sk-legacy');
    });
  });

  describe('resolveApiKey 优先级', () => {
    it('显式配置 > 环境变量 > opencode.db > auth.json', async () => {
      const dir = join(TMP, 'prio');
      seedDb(dir, [['opencode', OAUTH_VALUE, 1]]);
      seedAuth(dir, 'sk-legacy');
      const env = { XDG_DATA_HOME: dir };
      assert.equal(await resolveApiKey({ explicit: ' sk-explicit ', env }), 'sk-explicit');
      assert.equal(await resolveApiKey({ explicit: '', env: { ...env, OPENCODE_API_KEY: 'sk-env' } }), 'sk-env');
      assert.equal(await resolveApiKey({ env }), 'st-new');
      const dirNoDb = join(TMP, 'prio-auth-only');
      seedAuth(dirNoDb, 'sk-legacy');
      assert.equal(await resolveApiKey({ env: { XDG_DATA_HOME: dirNoDb } }), 'sk-legacy');
      assert.equal(await resolveApiKey({ env: {} }), undefined);
    });
  });
});
