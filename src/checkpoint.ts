import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';
const exec = promisify(execFile);
// Each checkpoint stores the whole day log again as a loose object. Git's own auto gc counts loose objects, not bytes, and waits for about 6,700 of them (some 1,000 checkpoints), so the checkpoint packs them itself once they pass this size.
const LOOSE_LIMIT_KIB = 16_384;

export async function checkpoint(directory: string) {
  const git = (args: string[]) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000 });
  if (!existsSync(join(directory, '.git'))) await git(['init', '-q', '-b', 'main']);
  if (!existsSync(join(directory, '.gitignore'))) atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n*.tmp\n');
  await git(['add', '-A', '--', '.']);
  const status = await git(['diff', '--cached', '--name-only']);
  if (!status.stdout.trim()) return;
  await git(['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Save OptChat memory']);
  const loose = Number(/^size: (\d+)$/m.exec((await git(['count-objects', '-v'])).stdout)?.[1]);
  // Cruft packs keep young unreachable objects packed instead of loose, which is the default only from git 2.40; without them every later checkpoint would gc again.
  // A failed gc, such as one blocked by another gc's lock, loses nothing: the commit has landed and the next checkpoint tries again.
  if (loose > LOOSE_LIMIT_KIB) await git(['-c', 'gc.cruftPacks=true', 'gc', '--quiet']).catch(() => {});
}
