import { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { Entry } from './panel-shared';

// Folded content is only rendered once opened: a collapsed source or preview costs nothing,
// where rendering it hidden would highlight every snippet the model read.
export function Fold({ className, summary, children }: { className: string; summary: React.ReactNode; children: () => React.ReactNode }) {
  const [opened, setOpened] = useState(false);
  return <details className={className} onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>{summary}</summary>
    {opened && children()}
  </details>;
}
// A blob URL per audio bubble, created once and revoked when the entry goes away.
export function AudioBubble({ audio }: { audio: NonNullable<Entry['audio']> }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(audio.blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [audio.blob]);
  return <div className="chat-audio">
    <AudioLines size={14} aria-hidden="true" />
    {url && <audio controls preload="metadata" src={url} aria-label={`Voice note, ${audio.seconds} seconds`} />}
    <span className="chat-audio-length">{Math.floor(audio.seconds / 60)}:{String(audio.seconds % 60).padStart(2, '0')}</span>
  </div>;
}
