import type { Spec } from '@json-render/core';
import { defineCatalog } from '@json-render/core';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { schema } from '@json-render/react/schema';
import { ExternalLink, GitBranch } from 'lucide-react';
import { z } from 'zod';
import type { GeneratedUi } from '../../lib/chat-stream';

const catalog = defineCatalog(schema, {
  components: {
    Board: { props: z.object({ eyebrow: z.string(), title: z.string(), note: z.string() }), slots: ['default'] },
    Project: { props: z.object({ name: z.string(), kicker: z.string(), summary: z.string(), href: z.string(), image: z.string().optional(), stack: z.array(z.string()), facts: z.array(z.object({ label: z.string(), value: z.string() })) }) },
    Research: { props: z.object({ title: z.string(), venue: z.string(), status: z.string(), finding: z.string(), href: z.string(), results: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })) }) },
    Work: { props: z.object({ employer: z.string(), title: z.string(), period: z.string(), summary: z.string(), stack: z.array(z.string()), href: z.string() }) },
    Skills: { props: z.object({ label: z.string(), items: z.array(z.string()) }) },
    Evidence: { props: z.object({ repo: z.string(), path: z.string(), range: z.string(), commit: z.string(), href: z.string(), symbols: z.array(z.string()) }) },
  },
  actions: {},
});

const trustedHref = (href: string) => href.startsWith('/') || /^https:\/\/(doi\.org|github\.com)\//.test(href) ? href : undefined;
const linkProps = (href: string) => href.startsWith('https://') ? { target: '_blank', rel: 'noopener noreferrer' } : {};
const Stack = ({ items }: { items: string[] }) => <ul className="gen-ui-tags">{items.map(item => <li key={item}>{item}</li>)}</ul>;

const { registry } = defineRegistry(catalog, {
  components: {
    Board: ({ props, children }) => <section className="gen-ui-board" aria-label={props.title}>
      <header className="gen-ui-head"><small>{props.eyebrow}</small><h3>{props.title}</h3><p>{props.note}</p></header>
      <div className="gen-ui-grid">{children}</div>
    </section>,
    Project: ({ props }) => {
      const href = trustedHref(props.href);
      const image = props.image?.startsWith('/assets/') ? props.image : undefined;
      return <article className="gen-ui-card gen-ui-project">
        {image && <img src={image} alt="" loading="lazy" />}
        <div className="gen-ui-card-body"><small>Project</small><h4>{props.name}</h4><p className="gen-ui-kicker">{props.kicker}</p><p>{props.summary}</p>
          <Stack items={props.stack} />
          {!!props.facts.length && <dl>{props.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
          {href && <a href={href} {...linkProps(href)}>Open project <ExternalLink size={11} aria-hidden="true" /></a>}
        </div>
      </article>;
    },
    Research: ({ props }) => {
      const href = trustedHref(props.href);
      return <article className="gen-ui-card gen-ui-research"><small>Research · {props.status}</small><h4>{props.title}</h4><p className="gen-ui-kicker">{props.venue}</p><p>{props.finding}</p>
        <dl className="gen-ui-results">{props.results.map(result => <div key={result.label}><dt>{result.label}</dt><dd>{result.value}</dd>{result.note && <small>{result.note}</small>}</div>)}</dl>
        {href && <a href={href} {...linkProps(href)}>View research <ExternalLink size={11} aria-hidden="true" /></a>}
      </article>;
    },
    Work: ({ props }) => {
      const href = trustedHref(props.href);
      return <article className="gen-ui-card"><small>Experience · {props.period}</small><h4>{props.title} at {props.employer}</h4><p>{props.summary}</p><Stack items={props.stack} />
        {href && <a href={href}>Open work sheet <ExternalLink size={11} aria-hidden="true" /></a>}
      </article>;
    },
    Skills: ({ props }) => <article className="gen-ui-card gen-ui-skills"><small>Capability</small><h4>{props.label}</h4><Stack items={props.items} /></article>,
    Evidence: ({ props }) => {
      const href = trustedHref(props.href);
      return <article className="gen-ui-card gen-ui-evidence"><small><GitBranch size={11} aria-hidden="true" /> Source evidence</small>
        <h4>{props.repo}/{props.path}:{props.range}</h4>
        <p>@ {props.commit}{props.symbols.length ? ` · ${props.symbols.join(', ')}` : ''}</p>
        {href && <a href={href} {...linkProps(href)}>Open exact lines <ExternalLink size={11} aria-hidden="true" /></a>}
      </article>;
    },
  },
});

export default function GeneratedUI({ ui }: { ui: GeneratedUi }) {
  const parsed = catalog.validate(ui.spec);
  if (!parsed.success) return null;
  const spec = parsed.data as Spec;
  return <div className="gen-ui-shell">
    <JSONUIProvider registry={registry} initialState={spec.state ?? {}}><Renderer spec={spec} registry={registry} /></JSONUIProvider>
    <p className="gen-ui-credit">Layout composed by Jev · {ui.model}</p>
  </div>;
}
