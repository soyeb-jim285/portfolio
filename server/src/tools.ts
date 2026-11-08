import { fail } from './assistant-tools/outcome';
import { createArtifact, prepareContact } from './assistant-tools/drafts';
import { runGitHubActivity } from './assistant-tools/github';
import { getAvailability, proposeBooking } from './assistant-tools/scheduling';
import { portfolioDetails, showImage, showSection } from './assistant-tools/site';
import { listFiles, readSource, searchKnowledge } from './assistant-tools/source';
import type { ToolContext, ToolOutcome } from './assistant-tools/types';

export { buildToolDefinitions } from './assistant-tools/definitions';
export type { ArtifactRequest, BookingProposal, ContactDraft, EventTypeChoice, ShownImage, Slot, ToolContext, ToolOutcome, UiAction } from './assistant-tools/types';

export async function runTool(context: ToolContext, name: string, rawArguments: string): Promise<ToolOutcome> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawArguments || '{}'); }
  catch { return fail('invalid arguments', 'The tool arguments were not valid JSON.'); }

  if (name === 'portfolio_details') return portfolioDetails(parsed);
  if (name === 'github_activity') return runGitHubActivity(context, parsed);
  if (name === 'search_knowledge') return searchKnowledge(context, parsed);
  if (name === 'read_source') return readSource(context, parsed);
  if (name === 'show_section') return showSection(parsed);
  if (name === 'show_image') return showImage(parsed);
  if (name === 'prepare_contact') return prepareContact(context, parsed);
  if (name === 'create_artifact') return createArtifact(context, parsed);
  if (name === 'get_availability') return getAvailability(context, parsed);
  if (name === 'propose_booking') return proposeBooking(context, parsed);
  if (name === 'list_files') return listFiles(context, parsed);

  return fail(`unknown tool ${name}`, `There is no tool named ${name}.`);
}
