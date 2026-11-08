-- Phase 3: UI actions the assistant requested, and what the browser reported back.
CREATE TABLE IF NOT EXISTS ui_actions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'done', 'missing', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS ui_actions_session_idx ON ui_actions (session_id);

-- Phase 4: contact drafts. A draft is only ever sent by the visitor, never by the model.
CREATE TABLE IF NOT EXISTS contact_drafts (
  id uuid PRIMARY KEY,
  session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'failed')),
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS contact_drafts_expiry_idx ON contact_drafts (expires_at) WHERE status = 'draft';
ALTER TABLE contact_drafts DROP CONSTRAINT IF EXISTS contact_drafts_status_check;
ALTER TABLE contact_drafts ADD CONSTRAINT contact_drafts_status_check CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'unknown'));

ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS contact_sends integer NOT NULL DEFAULT 0;

-- Phase 5: generated artifacts. The bytes live in object storage; this row is the permission check.
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  object_key text NOT NULL,
  bytes integer NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_expiry_idx ON artifacts (expires_at);

-- Phase 6: proposed calls. Only the visitor confirms one, and only after live availability agrees.
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  slot_start timestamptz NOT NULL,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  time_zone text NOT NULL DEFAULT 'UTC',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'conflict', 'failed', 'unknown')),
  provider_uid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS bookings_expiry_idx ON bookings (expires_at) WHERE status = 'pending';
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirming', 'confirmed', 'conflict', 'failed', 'unknown'));

ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS bookings integer NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type_id integer NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meeting_key text NOT NULL DEFAULT '';
