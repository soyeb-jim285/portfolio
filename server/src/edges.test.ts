import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleGraph, parseEdges } from './edges';

const file = (path: string, language: string, content: string) => ({ path, language, content });

test('C++ includes become edges only when the header is indexed', () => {
  const edges = parseEdges([
    file('src/services/fileoperations.cpp', 'cpp', '#include "fileoperations.h"\n#include <QThread>\n#include "../models/tabmodel.h"'),
    file('src/services/fileoperations.h', 'cpp', '#pragma once'),
    file('src/models/tabmodel.h', 'cpp', '#pragma once'),
  ]);
  assert.deepEqual(edges.map(edge => `${edge.from} -> ${edge.to}`).sort(), [
    'src/services/fileoperations.cpp -> src/models/tabmodel.h',
    'src/services/fileoperations.cpp -> src/services/fileoperations.h',
  ]);
  // <QThread> is a system header and is not in the repository, so it is not an edge.
  assert.ok(!edges.some(edge => edge.to.includes('QThread')));
});

test('TypeScript relative imports resolve, packages do not', () => {
  const edges = parseEdges([
    file('src/app.ts', 'typescript', "import { db } from './db';\nimport OpenAI from 'openai';\nexport { x } from '../lib/x';"),
    file('src/db.ts', 'typescript', 'export const db = 1;'),
    file('lib/x.ts', 'typescript', 'export const x = 1;'),
  ]);
  assert.deepEqual(edges.map(edge => edge.to).sort(), ['lib/x.ts', 'src/db.ts']);
});

test('QML component usage counts as a dependency when the component is a file here', () => {
  const edges = parseEdges([
    file('qml/Main.qml', 'qml', 'Rectangle {\n  Sidebar { }\n  Toolbar { }\n  Unknown { }\n}'),
    file('qml/components/Sidebar.qml', 'qml', 'Item { }'),
    file('qml/components/Toolbar.qml', 'qml', 'Item { }'),
  ]);
  assert.deepEqual(edges.filter(edge => edge.kind === 'component').map(edge => edge.to).sort(),
    ['qml/components/Sidebar.qml', 'qml/components/Toolbar.qml']);
  assert.ok(!edges.some(edge => edge.to.includes('Unknown')));
  // Rectangle and Item are Qt types, not files in the repository.
  assert.ok(!edges.some(edge => edge.to.includes('Rectangle')));
});

test('an ambiguous name is dropped rather than guessed', () => {
  const edges = parseEdges([
    file('a/main.cpp', 'cpp', '#include "util.h"'),
    file('b/util.h', 'cpp', '#pragma once'),
    file('c/util.h', 'cpp', '#pragma once'),
  ]);
  assert.deepEqual(edges, [], 'two candidates means no edge');
});

test('a file never depends on itself, and duplicates collapse', () => {
  const edges = parseEdges([
    file('src/a.ts', 'typescript', "import './a';\nimport './b';\nimport './b';"),
    file('src/b.ts', 'typescript', ''),
  ]);
  assert.deepEqual(edges, [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }]);
});

test('the module graph collapses files into directories and keeps the busiest', () => {
  const files = [
    { path: 'src/services/a.cpp', lines: 100 }, { path: 'src/services/b.cpp', lines: 50 },
    { path: 'src/models/c.cpp', lines: 30 }, { path: 'src/qml/d.qml', lines: 20 },
  ];
  const graph = moduleGraph(files, [
    { from: 'src/services/a.cpp', to: 'src/models/c.cpp', kind: 'include' },
    { from: 'src/services/b.cpp', to: 'src/models/c.cpp', kind: 'include' },
    { from: 'src/services/a.cpp', to: 'src/services/b.cpp', kind: 'include' },
  ], 2);
  assert.deepEqual(graph.nodes.map(node => [node.id, node.files, node.lines]), [['src/services', 2, 150], ['src/models', 1, 30]]);
  assert.deepEqual(graph.edges, [{ from: 'src/services', to: 'src/models', weight: 2 }]);
  assert.equal(graph.truncated, true);
  assert.equal(graph.moduleCount, 3);
});
