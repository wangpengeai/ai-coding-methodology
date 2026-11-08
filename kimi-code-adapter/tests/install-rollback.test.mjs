// 文件：install-rollback.test.mjs
// 描述：A5（内部任务-2 批）：kimi cli 值旗标吞值防护（对齐 zcode-adapter 评审 C2 形态）+
//       install 备份改 copy 式（原位留档）+ 回滚链容错（失败保留 .bak 供人工恢复，
//       对齐 zcode-adapter/src/install.mjs 先例姿态）。全部用例 --data-dir 指向 tmp，
//       绝不触真机宿主根（KIMI_CODE_HOME 亦指向 tmp 双保险）。
// 作者：wangp 创建：2026-10-05  版权：MIT（见仓库 LICENSE）
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_URL = new URL('../cli.mjs', import.meta.url);
const CLI_PATH = fileURLToPath(CLI_URL);
const { backupExisting, rollbackWrite, cleanupBackups, PLUGINS } = await import(CLI_URL);

function tmpRoot(label) {
  return join(tmpdir(), `kimi-a5-${label}-${process.pid}-${Date.now()}`);
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KIMI_CODE_HOME: join(tmpdir(), 'kimi-a5-home-absent'), ...env },
    timeout: 120_000,
    windowsHide: true,
  });
}

describe('install 回滚链与值旗标（DEV-2 批 A5）', () => {
it('A10 原子写：临时名带随机后缀 + 独占创建（防预置链接覆写）', () => {
  const src = readFileSync(CLI_PATH, 'utf8');
  assert.ok(src.includes('.kimi-tmp-${process.pid}-'), '临时名须含随机后缀（可预测名可被预置链接覆写）');
  assert.ok(src.includes("flag: 'wx'"), '临时文件须独占创建（不覆写已存在路径）');
});

it('A5 值旗标：值形如旗标（--data-dir --json）→ 用法错退 2，不把 --json 当路径', () => {
  const staging = tmpRoot('staging');
  try {
    const r = runCli(['install', '--staging', staging, '--data-dir', '--json']);
    assert.equal(r.status, 2, `应退 2（实得 ${r.status}；stdout=${String(r.stdout).slice(0, 200)}）`);
    assert.match(`${r.stdout}${r.stderr}`, /无法识别的参数/);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

it('A5 值旗标：缺值（--data-dir 置于末尾）→ 用法错退 2，不落宿主根', () => {
  const guardHome = tmpRoot('guard-home');
  mkdirSync(guardHome, { recursive: true });
  try {
    const r = runCli(['install', '--data-dir'], { env: { KIMI_CODE_HOME: guardHome } });
    assert.equal(r.status, 2, `缺值必须退 2 而不是继续装（实得 ${r.status}）`);
    assert.match(r.stderr, /用法|无法识别/);
    assert.equal(existsSync(join(guardHome, 'plugins', 'managed')), false, '缺值形态不得写宿主根');
  } finally {
    rmSync(guardHome, { recursive: true, force: true });
  }
});

it('A5 backupExisting：copy 式——原目录留位（marker 在场）+ .bak 副本齐备', () => {
  const root = tmpRoot('backup-copy');
  const managed = join(root, 'managed');
  mkdirSync(join(managed, 'workflow', 'hooks'), { recursive: true });
  writeFileSync(join(managed, 'workflow', 'hooks', 'marker.txt'), 'keep-me');
  try {
    const registryPath = join(root, 'installed.json');
    writeFileSync(registryPath, '{"version":1,"plugins":[]}');
    const { backups, registryBackup } = backupExisting(managed, registryPath, PLUGINS, '123');
    assert.ok(backups.has('workflow'), 'workflow 备份入账');
    assert.ok(backups.get('workflow').endsWith('.bak-123'));
    assert.equal(readFileSync(join(managed, 'workflow', 'hooks', 'marker.txt'), 'utf8'), 'keep-me', '原目录必须留位（copy 而非 rename——运行中会话钩子路径保护）');
    assert.equal(readFileSync(join(backups.get('workflow'), 'hooks', 'marker.txt'), 'utf8'), 'keep-me', '.bak 副本内容齐备');
    assert.ok(existsSync(registryBackup), '登记备份在场');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('A5 rollbackWrite：还原失败（测试缝注入）→ ok:false 且 .bak 保留', () => {
  const root = tmpRoot('rollback-fail');
  const managed = join(root, 'managed');
  const bak = join(managed, 'workflow.bak-777');
  mkdirSync(join(managed, 'workflow'), { recursive: true });
  mkdirSync(bak, { recursive: true });
  writeFileSync(join(bak, 'old.txt'), 'old');
  const prev = process.env.KIMI_TEST_ROLLBACK_FAIL;
  process.env.KIMI_TEST_ROLLBACK_FAIL = '1';
  try {
    const registryPath = join(root, 'installed.json');
    const out = rollbackWrite(managed, registryPath, new Map([['workflow', bak]]), null);
    assert.equal(out.ok, false, '注入失败必须 ok:false');
    assert.ok(out.failures.length >= 1 && out.failures[0].includes('workflow'), '失败项点名插件');
    assert.ok(existsSync(bak), '回滚失败时 .bak 必须保留（唯一原始副本）');
  } finally {
    if (prev === undefined) delete process.env.KIMI_TEST_ROLLBACK_FAIL;
    else process.env.KIMI_TEST_ROLLBACK_FAIL = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('A5 rollbackWrite + cleanupBackups：回滚成功（cp 还原）后备份统一清理、原内容恢复', () => {
  const root = tmpRoot('rollback-ok');
  const managed = join(root, 'managed');
  const bak = join(managed, 'workflow.bak-888');
  mkdirSync(bak, { recursive: true });
  writeFileSync(join(bak, 'old.txt'), 'original');
  try {
    const registryPath = join(root, 'installed.json');
    const backups = new Map([['workflow', bak]]);
    const out = rollbackWrite(managed, registryPath, backups, null);
    assert.equal(out.ok, true, `无注入时回滚应成功（failures=${JSON.stringify(out.failures)}）`);
    assert.equal(readFileSync(join(managed, 'workflow', 'old.txt'), 'utf8'), 'original', '原内容恢复（cp 对称还原）');
    assert.ok(existsSync(bak), '清理前 .bak 在场');
    cleanupBackups(backups, null);
    assert.equal(existsSync(bak), false, '回滚成功后备份统一清理');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('A5 e2e：登记损坏触发回滚 + 测试缝注入 → exit 1、输出含 .bak 人工恢复指引、.bak 实存', () => {
  const dataDir = tmpRoot('e2e-rollback');
  mkdirSync(join(dataDir, 'plugins', 'managed', 'workflow', 'hooks'), { recursive: true });
  writeFileSync(join(dataDir, 'plugins', 'managed', 'workflow', 'hooks', 'marker.txt'), 'old-install');
  writeFileSync(join(dataDir, 'plugins', 'installed.json'), '{ broken registry');
  try {
    const r = runCli(['install', '--data-dir', dataDir], { env: { KIMI_TEST_ROLLBACK_FAIL: '1' } });
    assert.equal(r.status, 1, `安装失败应退 1（实得 ${r.status}）`);
    const text = `${r.stdout}${r.stderr}`;
    assert.match(text, /备份保留|\.bak/, '输出必须含人工恢复指引（.bak 路径）');
    const baks = readdirSync(join(dataDir, 'plugins', 'managed')).filter((f) => f.includes('.bak-'));
    assert.ok(baks.length >= 1, `回滚失败时 .bak 必须留存（实得目录：${baks.join(',')}）`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

});
