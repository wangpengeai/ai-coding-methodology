// AC-EVID-001：capture_evidence 工具（含 F-2 脱敏族/命令脱敏/有损解码/append）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CORE_ROOT } from './helpers.mjs';

const TOOL = join(CORE_ROOT, 'validator/tools/capture_evidence.mjs');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dev151-evid-')));
function capture(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
}
const json = (r) => JSON.parse(r.stdout);

test('六字段、退出码透传、工作目录', () => {
  const project = tmp();
  const r = capture(['--project', project, '--criteria', 'smoke', '--', 'node', '-e', "console.log('ok'); process.exit(3)"]);
  assert.equal(r.status, 3);
  const e = json(r);
  for (const f of ['command', 'workingDirectory', 'selectionCriteria', 'exitCode', 'executedAt', 'keyOutputSummary']) assert.ok(f in e);
  assert.equal(e.exitCode, 3);
  assert.equal(e.selectionCriteria, 'smoke');
  // 契约：证据里的 workingDirectory 是 POSIX 分隔符归一形态（capture_evidence 写入前 replace），
  // 跨平台证据才可逐字比较；win32 上两者原生形态必不等（2026-10-20 内部任务-162，内部未决-146 首跑发现）。
  assert.equal(e.workingDirectory, project.replace(/\\/g, '/'));
  assert.ok(e.keyOutputSummary.includes('ok'));
});

test('F-2：JSON 键值/Bearer/Basic/AWS/GitHub/PEM 与命令参数脱敏', () => {
  const project = tmp();
  const r = capture(['--project', project, '--criteria', 'secrets', '--', 'node', '-e',
    "console.log('password: hunter2'); console.log('Authorization: Bearer abc.def.ghi'); console.log('Authorization: Basic dXNlcjpwYXNzd29yZA=='); console.log('AKIAABCDEFGHIJKLMNOP'); console.log('ghp_abcdefghijklmnopqrstuvwxyz0123456789'); console.log('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'); console.log('-----BEGIN PRIVATE KEY-----\\nSECRETBODY\\n-----END PRIVATE KEY-----')"]);
  const e = json(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.keyOutputSummary.includes('hunter2'), false);
  assert.equal(e.keyOutputSummary.includes('abc.def.ghi'), false);
  assert.equal(e.keyOutputSummary.includes('dXNlcjpwYXNzd29yZA=='), false);
  assert.equal(e.keyOutputSummary.includes('AKIAABCDEFGHIJKLMNOP'), false);
  assert.equal(e.keyOutputSummary.includes('ghp_'), false);
  assert.equal(e.keyOutputSummary.includes('sk-ant-api03'), false);
  assert.equal(e.keyOutputSummary.includes('SECRETBODY'), false);
  assert.ok(e.keyOutputSummary.includes('[redacted]'));
  // command 参数脱敏：长旗标、短旗标、= 形态与短旗标粘连
  const r2 = capture(['--project', project, '--criteria', 'cmd', '--', 'node', '-e', 'console.log(1)', '--password', 'hunter2', '-u', 'admin:S3cret', '-p', 'hunter3', '--db-password=hunter4', '-pS3cr3tPass', '-uadmin:pass']);
  const command = json(r2).command;
  for (const secret of ['hunter2', 'admin:S3cret', 'hunter3', 'hunter4', 'S3cr3tPass', 'admin:pass']) assert.equal(command.includes(secret), false, secret);
  assert.ok(command.includes('[redacted]'));
});

test('F-2 反例：sk- 普通词不误伤；普通文本不出现 redacted', () => {
  const project = tmp();
  const r = capture(['--project', project, '--criteria', 'false-positive', '--', 'node', '-e',
    "console.log('installed sk-learners package'); console.log('the skeleton is ready')"]);
  const summary = json(r).keyOutputSummary;
  assert.ok(summary.includes('sk-learners'));
  assert.ok(summary.includes('skeleton'));
  assert.equal(summary.includes('[redacted]'), false);
});

test('截断精确、--max-lines 0 不留正文', () => {
  const project = tmp();
  const r = capture(['--project', project, '--criteria', 'trunc', '--max-lines', '2', '--', 'node', '-e', "for(let i=1;i<=5;i++) console.log('line '+i)"]);
  const s = json(r).keyOutputSummary;
  assert.ok(s.includes('line 1') && s.includes('line 2'));
  assert.equal(s.includes('line 3'), false);
  assert.ok(s.includes('已截断，共 5 行'));
  // Python summarize 先 append 再判长度：--max-lines 0 仍保留 1 行
  const z = capture(['--project', project, '--criteria', 'zero', '--max-lines', '0', '--', 'node', '-e', "console.log('x')"]);
  assert.equal(json(z).keyOutputSummary, 'x');
});

test('append JSONL 落盘；坏字节有损解码并计数', () => {
  const project = tmp();
  const append = join(project, 'ev.jsonl');
  const r = capture(['--project', project, '--criteria', 'append', '--append', append, '--', 'node', '-e', "console.log('ok')"]);
  assert.equal(r.status, 0, r.stderr);
  const line = readFileSync(append, 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(line).selectionCriteria, 'append');
  const b = capture(['--project', project, '--criteria', 'bin', '--', 'node', '-e', "process.stdout.write(Buffer.from([0xff,0xfe,0x41]))"]);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(json(b).keyOutputSummary.includes('[decoding:'));
});

test('缺命令/缺 project/坏参数/落盘失败退 2（失败不输出证据）', () => {
  const project = tmp();
  assert.equal(capture(['--project', project, '--criteria', 'x']).status, 2);
  assert.equal(capture(['--criteria', 'x', '--', 'node', '-e', '1']).status, 2);
  assert.equal(capture(['--project', join(project, 'nope'), '--criteria', 'x', '--', 'node', '-e', '1']).status, 2);
  assert.equal(capture(['--project', project, '--criteria', 'x', '--max-lines', 'bad', '--', 'node', '-e', '1']).status, 2);
  const r = capture(['--project', project, '--criteria', 'x', '--append', project, '--', 'node', '-e', '1']);
  assert.equal(r.status, 2);
  assert.ok(json(r).error.includes('证据追加失败'));
  assert.equal('command' in json(r), false);
});
