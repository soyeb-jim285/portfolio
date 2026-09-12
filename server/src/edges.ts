// Dependency edges parsed from source, never guessed. An edge exists only when one indexed file
// names another and that target resolves to a file that is also indexed.
export type Edge = { from: string; to: string; kind: 'include' | 'import' | 'component' };

const PATTERNS: Record<string, { kind: Edge['kind']; pattern: RegExp }[]> = {
  cpp: [{ kind: 'include', pattern: /^\s*#\s*include\s+["<]([^">]+)[">]/gm }],
  // Covers `from 'x'`, the side-effect form `import 'x'`, require() and dynamic import().
  typescript: [{ kind: 'import', pattern: /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g }],
  python: [{ kind: 'import', pattern: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm }],
  qml: [
    { kind: 'import', pattern: /^\s*import\s+"([^"]+)"/gm },
    // A QML file using `Sidebar { ... }` depends on Sidebar.qml when that file exists here.
    { kind: 'component', pattern: /(?:^|\n)\s*([A-Z]\w+)\s*\{/g },
  ],
};

PATTERNS.javascript = PATTERNS.typescript;

const stem = (path: string) => path.replace(/\.[^./]+$/, '');
const dirOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

const resolveRelative = (from: string, target: string) => {
  const parts = `${dirOf(from)}/${target}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
};

/**
 * @param files every indexed path in the repository, with its language
 */
export function parseEdges(files: { path: string; language: string; content: string }[]): Edge[] {
  const byPath = new Set(files.map(file => file.path));
  const byBasename = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const file of files) {
    const name = file.path.split('/').pop()!;
    byBasename.set(name, [...(byBasename.get(name) ?? []), file.path]);
    byStem.set(stem(file.path), [...(byStem.get(stem(file.path)) ?? []), file.path]);
    const bare = stem(name);
    byStem.set(bare, [...(byStem.get(bare) ?? []), file.path]);
  }
  // Prefer a file in the same directory, then the only candidate; ambiguity is dropped.
  const pick = (from: string, candidates: string[] | undefined) => {
    if (!candidates?.length) return '';
    if (candidates.length === 1) return candidates[0];
    const sameDir = candidates.filter(candidate => dirOf(candidate) === dirOf(from));
    return sameDir.length === 1 ? sameDir[0] : '';
  };

  const edges = new Map<string, Edge>();
  for (const file of files) {
    for (const { kind, pattern } of PATTERNS[file.language] ?? []) {
      for (const match of file.content.matchAll(new RegExp(pattern))) {
        const raw = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
        if (!raw || raw.startsWith('@') || /^[a-z]+:/i.test(raw)) continue;
        let target = '';
        if (kind === 'component') {
          target = pick(file.path, byStem.get(raw));
        } else if (raw.startsWith('.')) {
          const resolved = resolveRelative(file.path, raw);
          target = byPath.has(resolved) ? resolved : pick(file.path, byStem.get(resolved));
        } else {
          target = pick(file.path, byBasename.get(raw.split('/').pop() ?? raw))
            || pick(file.path, byStem.get(raw.replace(/\./g, '/')));
        }
        if (!target || target === file.path) continue;
        edges.set(`${file.path}->${target}`, { from: file.path, to: target, kind });
      }
    }
  }
  return [...edges.values()];
}

export type GraphNode = { id: string; files: number; lines: number };
export type GraphEdge = { from: string; to: string; weight: number };

/** Files collapse into their directory, so the picture is modules rather than hundreds of nodes. */
export function moduleGraph(files: { path: string; lines: number }[], edges: Edge[], limit = 14) {
  const moduleOf = (path: string) => dirOf(path) || '(root)';
  const nodes = new Map<string, GraphNode>();
  for (const file of files) {
    const id = moduleOf(file.path);
    const node = nodes.get(id) ?? { id, files: 0, lines: 0 };
    node.files++; node.lines += file.lines;
    nodes.set(id, node);
  }
  const weights = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const from = moduleOf(edge.from);
    const to = moduleOf(edge.to);
    if (from === to) continue;
    const key = `${from}->${to}`;
    const existing = weights.get(key) ?? { from, to, weight: 0 };
    existing.weight++;
    weights.set(key, existing);
  }
  // Keep the busiest modules: a picture of everything is a picture of nothing.
  const ranked = [...nodes.values()].sort((a, b) => b.files - a.files).slice(0, limit);
  const kept = new Set(ranked.map(node => node.id));
  return {
    nodes: ranked,
    edges: [...weights.values()].filter(edge => kept.has(edge.from) && kept.has(edge.to)).sort((a, b) => b.weight - a.weight).slice(0, 40),
    truncated: nodes.size > ranked.length,
    moduleCount: nodes.size,
  };
}
