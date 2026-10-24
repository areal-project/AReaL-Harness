import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'));
const checkout = process.argv[2];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const file of upstream.files) {
  assert.equal(digest(await readFile(join(root, file.target))), file.localSha256, file.target);
  if (file.adaptations.length === 0) assert.equal(file.localSha256, file.sha256, file.target);
  if (checkout) {
    const bytes = execFileSync('git', ['show', `${upstream.commit}:${file.source}`], { cwd: checkout, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(digest(bytes), file.sha256, file.source);
  }
}
console.log(JSON.stringify({ ok: true, commit: upstream.commit, files: upstream.files.length, sourceVerified: Boolean(checkout) }));
