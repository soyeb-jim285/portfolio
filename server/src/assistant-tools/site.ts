import { findImage, findTarget, imageIds, targetIds } from '../../../src/data/site-map';
import { DETAILS, detailArgs, detailSlugs, imageArgs, showArgs } from './args';
import { asEvidence, fail } from './outcome';
import type { ToolOutcome } from './types';

export function portfolioDetails(parsed: unknown): ToolOutcome {
  const args = detailArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Unknown slug. Use one of: ${detailSlugs.join(', ')}`);
  // The site's own published copy, not indexed code: nothing to cite as a source file.
  return { summary: `details ${args.data.slug}`, result: `Portfolio write-up for ${args.data.slug}:\n${JSON.stringify(DETAILS[args.data.slug])}`, sources: [] };
}

export function showSection(parsed: unknown): ToolOutcome {
  const args = showArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Unknown section. Choose one of: ${targetIds.join(', ')}.`);
  const target = findTarget(args.data.target)!;
  return {
    summary: `show ${target.label.toLowerCase()}`,
    // The browser has not acted yet, so the model must not claim it has.
    result: asEvidence(`Requested: the visitor's browser will ${target.action === 'contact' ? 'open the message dialog' : `open ${target.route} and highlight the ${target.label.toLowerCase()}`}. It has not happened yet, so tell the visitor where you are taking them rather than claiming it is done.`),
    sources: [],
    action: { target: target.id, route: target.route, anchor: target.anchor, label: target.label, action: target.action ?? 'reveal' },
  };
}

export function showImage(parsed: unknown): ToolOutcome {
  const args = imageArgs.safeParse(parsed);
  if (!args.success) return fail('unknown image', `Unknown image. Choose one of: ${imageIds.join(', ')}.`);
  const image = findImage(args.data.image)!;
  return {
    summary: `show ${image.id}`,
    result: asEvidence(`The image is now displayed to the visitor with the caption "${image.caption}". Describe what it shows; do not repeat the caption.`),
    sources: [], image,
  };
}
