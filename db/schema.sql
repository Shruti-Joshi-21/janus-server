-- Janus database schema.
-- Conventions:
--   * ids are readable text: '<prefix>_<random>' (seed rows use names like 'hh_priya').
--   * phone numbers are E.164 ('+91…'). Money is whole rupees (integer).
--   * appliance_type values: 'ac', 'fridge', 'ro_purifier', 'washing_machine' (others allowed).
--   * service_type values are snake_case, e.g. 'gas_refill', 'pcb_replacement', 'filter_replacement'.

-- Short random id with a readable prefix, e.g. new_id('job') -> 'job_3f9a1c0b7d2e'
CREATE OR REPLACE FUNCTION new_id(prefix text) RETURNS text AS $$
  SELECT prefix || '_' || substr(md5(gen_random_uuid()::text), 1, 12);
$$ LANGUAGE sql VOLATILE;

-- ───────────────────────── People and places ─────────────────────────

CREATE TABLE societies (
  id          text PRIMARY KEY DEFAULT new_id('soc'),
  name        text NOT NULL,
  area        text,
  city        text NOT NULL,
  pincode     text,
  latitude    double precision,
  longitude   double precision,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE households (
  id               text PRIMARY KEY DEFAULT new_id('hh'),
  society_id       text REFERENCES societies(id),
  name             text NOT NULL,                 -- e.g. 'Priya & Rohan Sharma'
  flat             text,
  address          text,
  latitude         double precision,
  longitude        double precision,
  primary_phone    text NOT NULL,
  language         text NOT NULL DEFAULT 'en',    -- e.g. 'mr-hi-en' for mixed Marathi/Hindi/English
  availability     jsonb NOT NULL DEFAULT '{}',   -- when someone is home for a visit
  spend_limit      integer,                        -- Grantex: Janus may approve up to this amount (₹)
  onboarding_step  text NOT NULL DEFAULT 'start',
  onboarding_data  jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id            text PRIMARY KEY DEFAULT new_id('mem'),
  household_id  text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  phone         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('notified', 'decider', 'both')),
  language      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE technicians (
  id                   text PRIMARY KEY DEFAULT new_id('tech'),
  name                 text NOT NULL,
  phone                text NOT NULL UNIQUE,
  skills               text[] NOT NULL DEFAULT '{}',     -- appliance types he repairs
  contact_pref         text NOT NULL DEFAULT 'text' CHECK (contact_pref IN ('text', 'call', 'voice_note')),
  languages            text[] NOT NULL DEFAULT '{}',
  opted_in             boolean NOT NULL DEFAULT false,   -- agreed to receive WhatsApp from Janus
  availability_status  text NOT NULL DEFAULT 'unknown' CHECK (availability_status IN ('available', 'busy', 'away', 'unknown')),
  availability_until   timestamptz,
  source               text NOT NULL DEFAULT 'household' CHECK (source IN ('household', 'society_log', 'directory', 'brand')),
  upi_id               text,
  area                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Technicians a household already knows (their own "phone book").
CREATE TABLE household_technicians (
  household_id     text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  technician_id    text NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  appliance_types  text[] NOT NULL DEFAULT '{}',
  relationship     text NOT NULL DEFAULT 'known' CHECK (relationship IN ('known', 'amc')),
  note             text,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, technician_id)
);

-- Technicians recommended inside a society. Same phone may appear more than once; search merges them.
CREATE TABLE society_log (
  id                  text PRIMARY KEY DEFAULT new_id('slog'),
  society_id          text NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  technician_id       text NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  appliance_types     text[] NOT NULL DEFAULT '{}',
  added_by_member_id  text REFERENCES members(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Appliances and jobs ─────────────────────────

CREATE TABLE appliances (
  id                      text PRIMARY KEY DEFAULT new_id('app'),
  household_id            text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  type                    text NOT NULL,
  brand                   text,
  model                   text,
  serial                  text,
  purchase_date           date,
  warranty_end            date,
  brand_only              boolean NOT NULL DEFAULT false,  -- must go to the brand's service centre (e.g. under warranty)
  amc_provider            text,                            -- name of AMC provider, if any
  amc_technician_id       text REFERENCES technicians(id) ON DELETE SET NULL,
  amc_end                 date,
  amc_visit_every_months  integer,
  amc_next_due            date,
  status                  text NOT NULL DEFAULT 'working' CHECK (status IN ('working', 'faulty', 'under_repair', 'retired')),
  note                    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- state: 'new' → 'contacting' → 'slot_confirmed' → 'in_progress' → 'awaiting_payment' → 'paid' → 'closed'
--        (also 'technician_silent', 'escalated', 'cancelled')
CREATE TABLE jobs (
  id                  text PRIMARY KEY DEFAULT new_id('job'),
  household_id        text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  appliance_id        text REFERENCES appliances(id) ON DELETE SET NULL,
  technician_id       text REFERENCES technicians(id) ON DELETE SET NULL,
  route               text NOT NULL DEFAULT 'local' CHECK (route IN ('local', 'brand')),
  state               text NOT NULL DEFAULT 'new',
  urgent              boolean NOT NULL DEFAULT false,
  service_type        text,
  issue               text,
  brand_complaint_no  text,
  confirmed_slot      timestamptz,                    -- the visit time agreed with the technician
  created_at          timestamptz NOT NULL DEFAULT now(),
  contacted_at        timestamptz,
  slot_confirmed_at   timestamptz,
  arrived_at          timestamptz,
  done_at             timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- What was actually paid. Used for history and price fairness.
CREATE TABLE price_ledger (
  id              text PRIMARY KEY DEFAULT new_id('pay'),
  household_id    text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  job_id          text REFERENCES jobs(id) ON DELETE SET NULL,
  technician_id   text REFERENCES technicians(id) ON DELETE SET NULL,
  appliance_type  text NOT NULL,
  service_type    text NOT NULL,
  parts           integer CHECK (parts >= 0),
  labour          integer CHECK (labour >= 0),
  total           integer NOT NULL CHECK (total >= 0),
  method          text NOT NULL CHECK (method IN ('janus', 'direct_cash', 'direct_upi', 'partial')),
  reported_by     text NOT NULL CHECK (reported_by IN ('household', 'technician', 'system')),
  confirmed       boolean NOT NULL DEFAULT false,
  note            text,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ratings (
  id                  text PRIMARY KEY DEFAULT new_id('rate'),
  job_id              text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  household_id        text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  technician_id       text REFERENCES technicians(id) ON DELETE SET NULL,
  on_time             boolean,
  fixed               boolean,
  fair_price          boolean,
  reachable           boolean,
  replaces_rating_id  text REFERENCES ratings(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE complaints (
  id             text PRIMARY KEY DEFAULT new_id('cmp'),
  job_id         text REFERENCES jobs(id) ON DELETE SET NULL,
  household_id   text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  technician_id  text REFERENCES technicians(id) ON DELETE SET NULL,
  kind           text NOT NULL,                 -- e.g. 'repeat_fault', 'overcharge', 'no_show', 'damage'
  description    text,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id            text PRIMARY KEY DEFAULT new_id('ntf'),
  household_id  text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id     text REFERENCES members(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Things Janus must look at later ("did Ramesh reply within 2 hours?", "AMC visit due").
CREATE TABLE checks (
  id            text PRIMARY KEY DEFAULT new_id('chk'),
  household_id  text REFERENCES households(id) ON DELETE CASCADE,
  job_id        text REFERENCES jobs(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  due_at        timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  outcome       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX checks_due_idx ON checks (status, due_at);

-- ───────────────────────── Price reference data ─────────────────────────

CREATE TABLE reference_prices (
  id              serial PRIMARY KEY,
  appliance_type  text NOT NULL,
  service_type    text NOT NULL,
  city            text NOT NULL,
  parts_min       integer,
  parts_max       integer,
  labour_min      integer,
  labour_max      integer,
  total_min       integer,       -- used when the source only gives an all-in price
  total_max       integer,
  source          text NOT NULL,
  as_of           date NOT NULL,
  UNIQUE (appliance_type, service_type, city)
);

CREATE TABLE inflation_buffers (
  kind        text PRIMARY KEY CHECK (kind IN ('parts', 'labour')),
  annual_pct  numeric(5, 2) NOT NULL,
  note        text NOT NULL
);

-- ───────────────────────── Data behind mocks / custom capabilities ─────────────────────────

-- Known Pune places for the Delhivery Maps mock (geocode, validate, autosuggest).
CREATE TABLE delhivery_places (
  id            text PRIMARY KEY DEFAULT new_id('plc'),
  name          text NOT NULL,
  address_line  text NOT NULL,
  locality      text,
  city          text NOT NULL,
  state         text NOT NULL,
  pincode       text NOT NULL,
  latitude      double precision NOT NULL,
  longitude     double precision NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}'
);

-- Local businesses (Delhivery POI data) for technician_discovery.
CREATE TABLE technician_directory (
  id             text PRIMARY KEY DEFAULT new_id('dir'),
  name           text NOT NULL,
  business_name  text,
  phone          text NOT NULL UNIQUE,
  skills         text[] NOT NULL DEFAULT '{}',
  address        text,
  latitude       double precision NOT NULL,
  longitude      double precision NOT NULL,
  rating         numeric(2, 1),
  source         text NOT NULL DEFAULT 'delhivery_poi'
);

-- Merchants Pine Labs has KYC'd for UPI/QR acceptance (for technician_identity_check).
CREATE TABLE pine_merchants (
  merchant_id    text PRIMARY KEY,
  legal_name     text NOT NULL,
  display_name   text,
  phone          text NOT NULL UNIQUE,
  upi_id         text,
  kyc_status     text NOT NULL DEFAULT 'verified' CHECK (kyc_status IN ('verified', 'pending', 'rejected')),
  city           text,
  onboarded_at   date
);

-- Pine Labs mock state. Exact request/response fields are copied from Pine Labs docs in M8,
-- so the full request and our last response are kept as JSON.
CREATE TABLE mock_mandates (
  id               text PRIMARY KEY DEFAULT new_id('otm'),
  idempotency_key  text UNIQUE,
  status           text NOT NULL,
  amount           integer NOT NULL,
  valid_until      timestamptz,
  request          jsonb NOT NULL DEFAULT '{}',
  response         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mock_subscriptions (
  id               text PRIMARY KEY DEFAULT new_id('sub'),
  idempotency_key  text UNIQUE,
  status           text NOT NULL,
  amount           integer NOT NULL,
  frequency        text,
  request          jsonb NOT NULL DEFAULT '{}',
  response         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mock_payouts (
  id               text PRIMARY KEY DEFAULT new_id('pout'),
  idempotency_key  text UNIQUE,
  status           text NOT NULL,
  amount           integer NOT NULL,
  beneficiary      jsonb NOT NULL DEFAULT '{}',
  request          jsonb NOT NULL DEFAULT '{}',
  response         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_balance (
  merchant_id  text PRIMARY KEY,
  balance      integer NOT NULL,     -- ₹ available for payouts
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Demo controls and logs ─────────────────────────

-- Failure switches, e.g. ('pinelabs.next_payout', 'timeout', 1). uses_left NULL = until cleared.
CREATE TABLE scenarios (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  uses_left   integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Copy of every incoming WhatsApp message (from the Twilio webhook).
CREATE TABLE inbound_events (
  id                  text PRIMARY KEY DEFAULT new_id('evt'),
  channel             text NOT NULL DEFAULT 'whatsapp',
  from_phone          text NOT NULL,
  text                text,
  media_url           text,
  media_type          text,
  latitude            double precision,
  longitude           double precision,
  received_at         timestamptz NOT NULL DEFAULT now(),
  twilio_message_sid  text UNIQUE,
  raw                 jsonb NOT NULL DEFAULT '{}',
  forward_status      integer,          -- HTTP status from AgenticOrg webhook
  forward_error       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
