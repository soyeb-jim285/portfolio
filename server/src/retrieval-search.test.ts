import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { indexRepo } from './indexer';
import { createRetrieval, queryTerms } from './retrieval';
import { createFixture, fakeEmbedder, fakeGitHubOver, pool, run } from './test-retrieval-helpers';

let workspace = '';
let origin = '';
const fakeGitHub = fakeGitHubOver(() => origin);

before(async () => { ({ workspace, origin } = await createFixture()); });
after(async () => { await pool.end(); await rm(workspace, { recursive: true, force: true }); });

test('question words become a safe OR query, with camelCase split and kept whole', () => {
  const terms = queryTerms("How does DrawingCanvas capture what the user draws? ') | !x & (y");
  assert.equal(terms.split, 'how | does | drawing | canvas | capture | what | the | user | draws | x | y'.split(' | ').filter(word => word.length >= 2).join(' | '));
  assert.ok(terms.whole.includes('drawingcanvas'));
  assert.doesNotMatch(terms.split + terms.whole, /[^a-z0-9 |]/, 'nothing but words and the OR operator reaches to_tsquery');
});

test('each search improvement does what it claims on a fixture', async () => {
  const sketch = join(workspace, 'SketchPad');
  await mkdir(join(sketch, 'src'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', sketch]);
  await writeFile(join(sketch, 'src/DrawingCanvas.tsx'), 'export function DrawingCanvas() {\n  const strokes: Point[] = [];\n  const onPointerMove = (event: PointerEvent) => strokes.push([event.x, event.y]);\n  return onPointerMove;\n}\n');
  // Shares no word with the question it answers: only a summary can connect them.
  await writeFile(join(sketch, 'src/Scheduler.swift'), 'func nextInterval(stability: Double, grade: Int) -> Double {\n  return stability * pow(1.3, Double(grade))\n}\n');
  await writeFile(join(sketch, 'src/palette.ts'), 'export const palette = ["#000", "#fff"];\n');
  await run('git', ['add', '-A'], { cwd: sketch });
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'sketch'], { cwd: sketch });
  const previous = origin;
  origin = sketch;
  try {
    await indexRepo(pool, { name: 'SketchPad', owner: 'soyeb-jim285', url: sketch, branch: 'main', blurb: 'fixture' }, join(workspace, 'cache'), fakeEmbedder(), fakeGitHub);
  } finally { origin = previous; }
  const scope = { repo: 'sketchpad' };

  // OR matching over split, stemmed identifiers: "draws" and "capture" meet DrawingCanvas.
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const asked = await retrieval.search('how does it capture what the user draws', scope);
  assert.equal(asked[0].path, 'src/DrawingCanvas.tsx');
  assert.equal((await retrieval.search('DrawingCanvas', scope))[0].path, 'src/DrawingCanvas.tsx', 'exact identifiers still work');

  // Summaries: the description carries the words the code does not.
  const summary = 'Decides when a vocabulary word is reviewed again, using spaced repetition.';
  const [summaryVector] = await fakeEmbedder().embed([`SketchPad/src/Scheduler.swift\n${summary}`]);
  await pool.query(`UPDATE source_files SET summary = $1, summary_model = 'test', summary_embedding = $2::vector
                    WHERE path = 'src/Scheduler.swift' AND revision_id = (SELECT id FROM index_revisions WHERE repo = 'SketchPad' AND status = 'live')`,
    [summary, `[${summaryVector.join(',')}]`]);
  const withSummaries = await retrieval.search('when is a vocabulary word reviewed again', scope);
  assert.equal(withSummaries[0].path, 'src/Scheduler.swift', 'found through its summary');
});
