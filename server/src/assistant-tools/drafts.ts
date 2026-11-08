import { artifactArgs, draftArgs } from './args';
import { asEvidence, fail } from './outcome';
import type { ToolContext, ToolOutcome } from './types';

// Model-written Markdown is rendered with HTML disabled, but refuse the obvious attempts anyway
// so nothing dangerous is ever stored or handed to a download.
const UNSAFE_MARKDOWN = [/<\s*script/i, /<\s*iframe/i, /<\s*object/i, /<\s*embed/i, /javascript\s*:/i, /data\s*:\s*text\/html/i, /\son\w+\s*=/i];

export function prepareContact(context: ToolContext, parsed: unknown): ToolOutcome {
  const { contactEnabled } = context;
  if (!contactEnabled) return fail('contact unavailable', 'Message delivery is not configured. Point the visitor at the contact page or the email address in the portfolio facts.');
  const args = draftArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Invalid draft: ${args.error.issues[0]?.message}`);
  const draft = { name: args.data.name ?? '', email: args.data.email ?? '', message: args.data.message ?? '' };
  const missing = [!draft.name && 'name', !draft.email && 'email', !draft.message && 'message'].filter(Boolean);
  return {
    summary: `draft message${missing.length ? ` (missing ${missing.join(', ')})` : ''}`,
    // There is no tool that sends: the visitor's own click is the only path to the provider.
    result: asEvidence(`A draft preview is now shown to the visitor with these fields${missing.length ? `, still missing: ${missing.join(', ')}` : ''}. They can edit every field and must press Send themselves; you cannot send it and must not claim it was sent. Ask for anything missing.`),
    sources: [], draft,
  };
}

export function createArtifact(context: ToolContext, parsed: unknown): ToolOutcome {
  const { artifactsEnabled, maxArtifactBytes } = context;
  if (!artifactsEnabled) return fail('artifacts unavailable', 'Artifact storage is not configured, so you cannot produce a document. Answer in the chat instead.');
  const args = artifactArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Invalid artifact: ${args.error.issues[0]?.message}`);
  if (Buffer.byteLength(args.data.markdown, 'utf8') > maxArtifactBytes) {
    return fail('artifact too large', `The document exceeds ${maxArtifactBytes} bytes. Write a shorter one.`);
  }
  if (UNSAFE_MARKDOWN.some(pattern => pattern.test(args.data.markdown))) {
    return fail('artifact rejected', 'The document contained HTML or a script-like URL. Write plain Markdown, with Mermaid in a fenced block.');
  }
  if (args.data.kind === 'diagram' && !/```mermaid/.test(args.data.markdown)) {
    return fail('invalid arguments', 'A diagram artifact must contain a ```mermaid fenced block.');
  }
  return {
    summary: `${args.data.kind} "${args.data.title}"`,
    result: asEvidence('The document is now shown to the visitor with a download link. Say what it contains; do not repeat it in full.'),
    sources: [], artifact: args.data,
  };
}
