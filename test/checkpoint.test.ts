import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint } from '../src/checkpoint.ts';

const tracked = (dir: string) => execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');

test('a checkpoint writes the ignore file whenever it is missing, and never replaces one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-checkpoint-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    mkdirSync(join(dir, 'main'));
    writeFileSync(join(dir, 'main', 'a.jsonl'), '{}\n'); writeFileSync(join(dir, 'usage.jsonl'), '{}\n'); writeFileSync(join(dir, 'memory.html'), '<p>');
    await checkpoint(dir);
    assert.deepEqual(tracked(dir), ['.gitignore', 'main/a.jsonl']);
    writeFileSync(join(dir, '.gitignore'), '/mine/\n');
    await checkpoint(dir);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '/mine/\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a day of checkpoints keeps .git near the size of the log, not one copy of it per turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-checkpoint-'));
  try {
    mkdirSync(join(dir, 'main'));
    const log = join(dir, 'main', 'a.jsonl');
    writeFileSync(log, `${JSON.stringify(randomBytes(3_000_000).toString('base64'))}\n`);
    for (let turn = 0; turn < 12; turn++) { appendFileSync(log, `{"turn":${turn}}\n`); await checkpoint(dir); }
    const counts = execFileSync('git', ['-C', dir, 'count-objects', '-v'], { encoding: 'utf8' });
    const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(counts)![1]);
    assert.equal(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '12');
    assert.ok(kib('size') + kib('size-pack') < 24 * 1024, `.git holds ${kib('size')} KiB loose and ${kib('size-pack')} KiB packed for a 4 MB log`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a checkpoint whose commit lands resolves even when git cannot pack afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-checkpoint-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    writeFileSync(join(dir, '.git', 'gc.pid'), `${process.pid} ${hostname()}`);
    writeFileSync(join(dir, 'big.bin'), randomBytes(17_000_000));
    await checkpoint(dir);
    assert.equal(execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' }).trim(), 'Save OptChat memory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
