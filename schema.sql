-- Applied on every boot by src/db.js; statements must stay idempotent.
-- Later modules add columns with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS shares (
  mid text PRIMARY KEY,
  sender_id text NOT NULL,
  reel_url text NOT NULL,
  caption text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'received',
  failure_reason text,
  event_ids jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz,
  extracted_at timestamptz,
  calendared_at timestamptz,
  replied_at timestamptz
);

-- Module 2: caption + transcript + on-screen text, the input to extraction.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS bundle jsonb;

-- Module 3: the verified opportunities (deadline, link, sources) found for the reel.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS extraction jsonb;

-- Module 5: the bot's reply message id, so "undo" sent as a reply to it finds the right share.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS reply_mid text;

-- Module 5: text messages seen, so a redelivered "undo" never undoes a second share.
CREATE TABLE IF NOT EXISTS texts (
  mid text PRIMARY KEY,
  sender_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
