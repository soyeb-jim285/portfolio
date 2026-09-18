import type { ToolActivity } from './chat-stream';

const labels: Record<string, string> = {
  search_knowledge: 'Searching the knowledge base…',
  read_source: 'Reading source code…',
  list_files: 'Exploring repository files…',
  create_artifact: 'Creating your document…',
  show_section: 'Finding the right section…',
  show_image: 'Finding a project image…',
  prepare_contact: 'Drafting your message…',
  get_availability: 'Checking calendar availability…',
  propose_booking: 'Preparing your meeting details…',
};

export function workingLabel(tools: ToolActivity[] = [], hasText = false) {
  const active = tools.findLast(tool => tool.status === 'running');
  if (active) return labels[active.name] ?? 'Working on your request…';
  if (hasText) return 'Writing the response…';
  if (tools.length) return 'Reviewing the results…';
  return 'Considering your request…';
}
