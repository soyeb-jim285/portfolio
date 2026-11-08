import { useRef, useState } from 'react';
import { DEFAULT_WIDTH, type Entry } from './panel-shared';

// Every piece of panel state and every ref, declared together and in one fixed order.
export function usePanelState() {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  // Only failures the message list cannot show sit above the composer; progress stays in the live region.
  const [alert, setAlert] = useState('');
  const [copied, setCopied] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [openDays, setOpenDays] = useState<Record<string, string>>({});
  // A finished take waits in the footer until the visitor sends or discards it.
  const [take, setTake] = useState<{ blob: Blob; seconds: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  // stop() is the only way out of a recording, so discard is a flag its handler reads.
  const discard = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const token = useRef<string | undefined>(undefined);
  const challengeSlot = useRef<HTMLDivElement>(null);
  // Saving waits for the stored conversation to load, so an empty first render never overwrites it.
  const loaded = useRef(false);
  // Actions run exactly once: replaying a stored conversation must not navigate the visitor again.
  const performed = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const follow = useRef(true);
  // Id of the user message pinned to the top of the viewport for the current turn.
  const anchor = useRef('');
  const spacer = useRef<HTMLDivElement>(null);
  // True while the running turn owns the scroll position; any manual scroll hands it back.
  const pinned = useRef(false);

  return { open, setOpen, mobile, setMobile, portal, setPortal, entries, setEntries, question, setQuestion, busy, setBusy, status, setStatus, alert, setAlert, copied, setCopied, atBottom, setAtBottom, width, setWidth, openDays, setOpenDays, take, setTake, recording, setRecording, seconds, setSeconds, recorder, discard, input, viewport, token, challengeSlot, loaded, performed, controller, follow, anchor, spacer, pinned };
}

export type PanelState = ReturnType<typeof usePanelState>;
