import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkFile, languageOf, skipReason, symbolsIn, CHUNK_LINES, CHUNK_STRIDE, MAX_FILE_BYTES } from './chunker';

test('language detection covers the indexed repositories and rejects the rest', () => {
  assert.equal(languageOf('src/FileOps.cpp'), 'cpp');
  assert.equal(languageOf('src/ui/Grid.qml'), 'qml');
  assert.equal(languageOf('CMakeLists.txt'), 'cmake');
  assert.equal(languageOf('docs/notes.txt'), '');
  assert.equal(languageOf('cmake/Deps.cmake'), 'cmake');
  assert.equal(languageOf('qml/qmldir'), 'qml');
  assert.equal(languageOf('assets/icon.png'), '');
});

test('skips vendored, oversized, binary, generated and credential-bearing files', () => {
  assert.equal(skipReason('src/app.cpp', 100, 'int main() {}'), '');
  assert.match(skipReason('node_modules/x/a.js', 10, 'x'), /vendored/);
  assert.match(skipReason('build/gen.cpp', 10, 'x'), /vendored/);
  assert.match(skipReason('.env.production', 10, 'KEY=1'), /credential-shaped/);
  assert.match(skipReason('deploy/server.key', 10, 'x'), /credential-shaped/);
  assert.match(skipReason('src/a.cpp', MAX_FILE_BYTES + 1, 'x'), /larger than/);
  assert.match(skipReason('src/a.cpp', 10, 'a\0b'), /binary/);
  assert.match(skipReason('src/a.cpp', 10, '   '), /empty/);
  assert.match(skipReason('src/config.cpp', 50, 'const auto key = "sk-abcdefghijklmnopqrstuvwxyz123456";'), /credential in content/);
  assert.match(skipReason('src/key.cpp', 50, '-----BEGIN RSA PRIVATE KEY-----'), /credential/);
  assert.match(skipReason('src/bundle.js', 50, `${'x'.repeat(2000)}\n`), /minified/);
});

test('extracts symbols per language and ignores control keywords', () => {
  const cpp = symbolsIn(`class FileOps : public QObject {\nvoid FileOps::copy(const QList<QUrl> &sources) {\n  if (sources.isEmpty()) {\n    return;\n  }\n}`, 'cpp');
  assert.ok(cpp.includes('FileOps'));
  assert.ok(cpp.includes('copy'));
  assert.ok(!cpp.includes('if'));
  const qml = symbolsIn(`Rectangle {\n  id: pane\n  property int columnWidth: 80\n  signal opened\n  function focusNext() {}\n}`, 'qml');
  assert.deepEqual(qml.sort(), ['Rectangle', 'columnWidth', 'focusNext', 'opened', 'pane']);
  assert.deepEqual(symbolsIn('def train(model):\n  pass\nclass Trainer:\n  pass', 'python').sort(), ['Trainer', 'train']);
  assert.deepEqual(symbolsIn('anything', 'toml'), []);
});

test('chunks overlap, cover every line and carry stable hashes', () => {
  const lines = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join('\n');
  const chunks = chunkFile('src/big.cpp', lines);
  assert.deepEqual(chunks.map(chunk => [chunk.startLine, chunk.endLine]), [[1, CHUNK_LINES], [CHUNK_STRIDE + 1, CHUNK_STRIDE + CHUNK_LINES], [2 * CHUNK_STRIDE + 1, 130]]);
  assert.ok(chunks[1].startLine <= chunks[0].endLine, 'consecutive chunks must overlap');
  assert.equal(chunks.at(-1)!.endLine, 130);
  assert.deepEqual(chunkFile('src/big.cpp', lines)[0].contentHash, chunks[0].contentHash);
  assert.notDeepEqual(chunkFile('src/big.cpp', `${lines}\nextra`)[2].contentHash, chunks[2].contentHash);
  assert.equal(chunkFile('src/one.cpp', 'int main() {}').length, 1);
  assert.deepEqual(chunkFile('src/blank.cpp', '\n\n\n'), []);
});
