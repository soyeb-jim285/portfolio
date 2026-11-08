import { imageIds, siteImages, siteTargets, targetIds } from '../../../src/data/site-map';
import { MAX_READ_LINES } from '../retrieval';
import { ARTIFACT_KINDS, detailSlugs, githubParameters } from './args';

export const buildToolDefinitions = (repoNames: string[], liveGitHub = false) => [
  ...(liveGitHub && repoNames.length ? [{
    type: 'function' as const,
    function: {
      name: 'github_activity',
      description: 'Live, read-only GitHub data for one of the listed repositories. The code index is a daily snapshot: use this for anything recent or anything the index does not hold, such as commits, what a commit changed, pull requests, issues, releases, stars and contributors.',
      strict: true,
      parameters: githubParameters(repoNames),
    },
  }] : []),
  {
    type: 'function' as const,
    function: {
      name: 'search_knowledge',
      description: `Search the indexed source code of Jim's repositories for code relevant to a question. Returns file paths, line ranges, detected symbols and snippets from a pinned commit. Use it before making any claim about how the code works.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for: a behaviour, identifier or file name.' },
          repo: { type: 'string', enum: repoNames, description: 'Restrict the search to one repository.' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results, default 6.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_source',
      description: `Read a bounded window of one indexed file (at most ${MAX_READ_LINES} lines) to confirm a detail before describing it.`,
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', enum: repoNames },
          path: { type: 'string', description: 'Repository-relative path exactly as returned by search_knowledge.' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['repo', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_section',
      description: `Take the visitor to a part of this website and highlight it. Use it when showing something is better than describing it, and when the visitor asks where something is. One target per call; call it again for a short guided tour. Targets:\n${siteTargets.map(target => `- ${target.id}: ${target.description}`).join('\n')}`,
      parameters: { type: 'object', properties: { target: { type: 'string', enum: targetIds } }, required: ['target'], additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_image',
      description: `Put one of the portfolio's own screenshots on screen, when seeing it helps more than describing it. Available images:\n${siteImages.map(image => `- ${image.id}: ${image.caption}`).join('\n')}`,
      parameters: { type: 'object', properties: { image: { type: 'string', enum: imageIds } }, required: ['image'], additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'prepare_contact',
      description: 'Draft a message to Jim and show the visitor an editable preview. Fill in whatever you already know and leave the rest empty; include a short summary of the conversation in the message only when the visitor wants it. You cannot send: the visitor reviews the draft and presses Send.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The visitor's name." },
          email: { type: 'string', description: "The visitor's email address, used as the reply address." },
          message: { type: 'string', description: 'The message body, written as the visitor.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_artifact',
      description: 'Produce a downloadable Markdown document the visitor can keep: a technical brief, a project comparison, or an architecture diagram. Write it yourself in Markdown. Cite the source ranges you actually read as repo/path:lines, and label anything you inferred rather than read. Use it when the visitor asks for something to take away, not for ordinary answers.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...ARTIFACT_KINDS], description: 'brief, comparison, or diagram.' },
          title: { type: 'string', description: 'Short document title.' },
          markdown: { type: 'string', description: 'The document body in Markdown. No HTML. A diagram goes in a ```mermaid fenced block.' },
        },
        required: ['kind', 'title', 'markdown'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_availability',
      description: "Fetch Jim's real free slots from his calendar and show them to the visitor as a picker. Every time you mention availability, call this first: there is no other source of free times and you must never invent one. Meeting lengths are listed in the system prompt; ask the visitor which suits them if it is not obvious.",
      parameters: {
        type: 'object',
        properties: { duration: { type: 'string', description: 'Which meeting to check, by its key such as "30min". Defaults to the first one.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_booking',
      description: 'Show a confirmation card for one free slot, prefilled with whatever attendee details you know. The slot is re-checked against the calendar first. You cannot book: the visitor confirms.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Slot start as an ISO 8601 instant, exactly as returned by get_availability.' },
          duration: { type: 'string', description: 'The meeting key, such as "30min". Must match the one the slot came from.' },
          name: { type: 'string', description: "The visitor's name." },
          email: { type: 'string', description: "The visitor's email address." },
          notes: { type: 'string', description: 'What the call is about, one or two lines.' },
        },
        required: ['start'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List the indexed files of one repository when a path is needed but unknown.',
      parameters: { type: 'object', properties: { repo: { type: 'string', enum: repoNames } }, required: ['repo'], additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'portfolio_details',
      description: "The full write-up of one of Jim's projects or papers: how a project started, its features in detail, what users said about it, or a paper's abstract. The prompt only carries summaries.",
      parameters: { type: 'object', properties: { slug: { type: 'string', enum: detailSlugs } }, required: ['slug'], additionalProperties: false },
    },
  },
];
