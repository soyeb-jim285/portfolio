import { createHash } from 'node:crypto';

const LANGUAGES: Record<string, string> = {
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', qml: 'qml', js: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', swift: 'swift', sh: 'shell', bash: 'shell', nix: 'nix',
  md: 'markdown', toml: 'toml', json: 'json', yml: 'yaml', yaml: 'yaml', cmake: 'cmake', qmldir: 'qml', pro: 'qmake',
};
const NAMED_FILES: Record<string, string> = { CMakeLists: 'cmake', Makefile: 'make', Dockerfile: 'docker' };
// Anything not obviously source, plus anywhere generated or vendored code hides.
const SKIPPED_DIRS = /(^|\/)(\.git|node_modules|build|builddir|dist|out|target|vendor|third_party|3rdparty|external|subprojects|\.venv|__pycache__|\.cache)(\/|$)/;
const SECRET_FILES = /(^|\/)(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_[rd]sa|.*secret.*|.*credentials.*)$/i;
// Conservative: a match means the file is skipped, not redacted.
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/,
];

export const MAX_FILE_BYTES = 200_000;
export const CHUNK_LINES = 60;
export const CHUNK_STRIDE = 48;

export const languageOf = (path: string) => {
  const name = path.split('/').pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, '');
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  // Extensionless names matter here: quill ships a `qmldir`, C++ repos ship `CMakeLists.txt`.
  return LANGUAGES[extension] ?? NAMED_FILES[stem] ?? NAMED_FILES[name] ?? LANGUAGES[name.toLowerCase()] ?? '';
};

export function skipReason(path: string, bytes: number, content: string) {
  if (SKIPPED_DIRS.test(path)) return 'generated or vendored path';
  if (SECRET_FILES.test(path)) return 'credential-shaped filename';
  if (!languageOf(path)) return 'unindexed file type';
  if (bytes > MAX_FILE_BYTES) return `larger than ${MAX_FILE_BYTES} bytes`;
  if (content.includes('\0')) return 'binary content';
  if (!content.trim()) return 'empty file';
  if (SECRET_CONTENT.some(pattern => pattern.test(content))) return 'possible credential in content';
  // A minified or generated bundle is one enormous line; it is noise in a citation.
  if (content.length / (content.split('\n').length || 1) > 400) return 'generated or minified content';
  return '';
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  cpp: [/\b(?:class|struct|namespace|enum)\s+(?:Q_\w+\s+)?([A-Za-z_]\w*)/g, /(?:^|\n)[\w:<>,\s*&~]*?\b([A-Za-z_]\w*)\s*\([^;()]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{/g],
  qml: [/(?:^|\n)\s*([A-Z]\w*)\s*\{/g, /\bfunction\s+([A-Za-z_]\w*)/g, /\bproperty\s+\w+\s+([A-Za-z_]\w*)/g, /\bsignal\s+([A-Za-z_]\w*)/g, /\bid\s*:\s*([A-Za-z_]\w*)/g],
  typescript: [/\b(?:class|interface|type|enum)\s+([A-Za-z_]\w*)/g, /\bfunction\s+([A-Za-z_]\w*)/g, /\b(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/g],
  python: [/\b(?:def|class)\s+([A-Za-z_]\w*)/g],
  swift: [/\b(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/g, /\bfunc\s+([A-Za-z_]\w*)/g],
  cmake: [/\b(?:add_library|add_executable|function|macro)\s*\(\s*([A-Za-z_]\w*)/g],
  markdown: [/(?:^|\n)#{1,3}\s+(.+)/g],
};
SYMBOL_PATTERNS.javascript = SYMBOL_PATTERNS.typescript;

export function symbolsIn(text: string, language: string, limit = 12) {
  const found = new Set<string>();
  for (const pattern of SYMBOL_PATTERNS[language] ?? []) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[1]?.trim();
      // Drop control keywords that the brace pattern picks up as if they were functions.
      if (symbol && symbol.length > 1 && symbol.length <= 80 && !/^(if|for|while|switch|catch|return|else|do|try)$/.test(symbol)) found.add(symbol);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

export type Chunk = { path: string; language: string; symbols: string[]; startLine: number; endLine: number; content: string; contentHash: Buffer };
export const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Fixed overlapping line windows: predictable citations, and every line appears in some chunk.
export function chunkFile(path: string, content: string): Chunk[] {
  const language = languageOf(path);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_STRIDE) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    const text = slice.join('\n');
    if (text.trim()) {
      chunks.push({
        path, language, symbols: symbolsIn(text, language),
        startLine: start + 1, endLine: start + slice.length, content: text, contentHash: sha256(text),
      });
    }
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}
