-- Janus demo cast. Phone numbers are PLACEHOLDERS (+9190000000xx) until Shruti sends the real ones.
-- Dates near "today" are relative (current_date) so the demo always looks fresh after a reset.

SET TIME ZONE 'Asia/Kolkata';

-- ───────────────────────── Society and households ─────────────────────────

INSERT INTO societies (id, name, area, city, pincode, latitude, longitude) VALUES
  ('soc_sai_heights', 'Sai Heights', 'Baner', 'Pune', '411045', 18.5603, 73.7812);

INSERT INTO households (id, society_id, name, flat, address, latitude, longitude, primary_phone, language, availability, spend_limit, onboarding_step) VALUES
  ('hh_priya', 'soc_sai_heights', 'Priya & Rohan', '4B',
   'Flat 4B, Sai Heights, Baner, Pune, Maharashtra 411045', 18.5603, 73.7812,
   '+919000000001', 'mr-hi-en',
   '{"tz":"Asia/Kolkata","weekdays":[{"from":"16:00","to":"20:00"}],"weekends":[{"from":"10:00","to":"18:00"}]}',
   5000, 'done'),
  -- Neighbours: give the society-average price tier enough data points. Never shown by name to Priya.
  ('hh_mehta', 'soc_sai_heights', 'Mehta family', '7A',
   'Flat 7A, Sai Heights, Baner, Pune, Maharashtra 411045', 18.5603, 73.7812,
   '+919000000031', 'hi-en', '{}', 3000, 'done'),
  ('hh_kulkarni', 'soc_sai_heights', 'Kulkarni family', '2C',
   'Flat 2C, Sai Heights, Baner, Pune, Maharashtra 411045', 18.5603, 73.7812,
   '+919000000032', 'mr-en', '{}', 3000, 'done'),
  ('hh_deshpande', 'soc_sai_heights', 'Deshpande family', '9D',
   'Flat 9D, Sai Heights, Baner, Pune, Maharashtra 411045', 18.5603, 73.7812,
   '+919000000033', 'mr-en', '{}', 3000, 'done');

INSERT INTO members (id, household_id, phone, name, role, language) VALUES
  ('mem_priya',  'hh_priya',     '+919000000001', 'Priya',          'decider', 'mr-hi-en'),
  ('mem_rohan',  'hh_priya',     '+919000000002', 'Rohan',          'decider', 'hi-en'),
  ('mem_neha',   'hh_mehta',     '+919000000031', 'Neha Mehta',     'both',    'hi-en'),
  ('mem_ajit',   'hh_kulkarni',  '+919000000032', 'Ajit Kulkarni',  'both',    'mr-en'),
  ('mem_sunita', 'hh_deshpande', '+919000000033', 'Sunita Deshpande','both',   'mr-en');

-- ───────────────────────── Technicians ─────────────────────────

INSERT INTO technicians (id, name, phone, skills, contact_pref, languages, opted_in, availability_status, source, upi_id, area) VALUES
  ('tech_ramesh', 'Ramesh Patil', '+919000000011', '{ac,fridge}',   'text',       '{mr,hi}',    true,  'available', 'household',   'ramesh.cooling@okaxis', 'Baner'),
  ('tech_suresh', 'Suresh More',  '+919000000012', '{ro_purifier}', 'voice_note', '{mr,hi}',    true,  'available', 'society_log', 'suresh.ro@ybl',         'Baner'),
  ('tech_anil',   'Anil Kale',    '+919000000013', '{ac}',          'call',       '{hi,mr,en}', false, 'unknown',   'society_log', NULL,                    'Aundh');

INSERT INTO household_technicians (household_id, technician_id, appliance_types, relationship, note) VALUES
  ('hh_priya', 'tech_ramesh', '{ac,fridge}',   'known', 'Priya''s regular technician for AC and fridge.'),
  ('hh_priya', 'tech_suresh', '{ro_purifier}', 'amc',   'Kent RO AMC, visits every 3 months.');

-- Suresh appears twice on purpose: society_log_search must merge duplicates by phone.
INSERT INTO society_log (id, society_id, technician_id, appliance_types, added_by_member_id, note) VALUES
  ('slog_suresh_1', 'soc_sai_heights', 'tech_suresh', '{ro_purifier}', 'mem_priya', 'Does the Kent AMC for several flats.'),
  ('slog_suresh_2', 'soc_sai_heights', 'tech_suresh', '{ro_purifier}', 'mem_ajit',  'Reliable, comes on Saturdays.'),
  ('slog_anil_1',   'soc_sai_heights', 'tech_anil',   '{ac}',          'mem_neha',  'Cheap but had an issue with a gas top-up.'),
  ('slog_ramesh_1', 'soc_sai_heights', 'tech_ramesh', '{ac,fridge}',   'mem_sunita','Good with split ACs.');

-- ───────────────────────── Priya's appliances ─────────────────────────

INSERT INTO appliances (id, household_id, type, brand, model, serial, purchase_date, warranty_end, brand_only,
                        amc_provider, amc_technician_id, amc_end, amc_visit_every_months, amc_next_due, status, note) VALUES
  ('app_priya_ac', 'hh_priya', 'ac', 'Voltas', '183V Vectra Elite (1.5 ton split)', 'VOL21A0457812',
   '2021-04-20', '2022-04-20', false, NULL, NULL, NULL, NULL, NULL, 'working', 'Out of warranty.'),
  ('app_priya_ro', 'hh_priya', 'ro_purifier', 'Kent', 'Grand Plus', 'KNT-GP-88231',
   '2022-08-02', '2023-08-02', false, 'Suresh More (AMC)', 'tech_suresh',
   current_date + 180, 3, current_date + 2, 'working', 'AMC with Suresh; next visit due in 2 days.'),
  ('app_priya_wm', 'hh_priya', 'washing_machine', 'LG', 'FHM1408BDL (8 kg front load)', 'LG25WM330915',
   '2025-03-15', '2027-03-15', true, NULL, NULL, NULL, NULL, NULL, 'working', 'Under warranty — repairs must go through LG service.'),
  ('app_priya_fridge', 'hh_priya', 'fridge', 'Whirlpool', 'IF INV CNV 278 (double door)', 'WHP17FR220461',
   '2017-06-10', '2018-06-10', false, NULL, NULL, NULL, NULL, NULL, 'working', 'Out of warranty.');

-- ───────────────────────── Past jobs, payments, ratings ─────────────────────────

INSERT INTO jobs (id, household_id, appliance_id, technician_id, route, state, service_type, issue,
                  confirmed_slot, created_at, contacted_at, slot_confirmed_at, arrived_at, done_at) VALUES
  ('job_priya_ac_gas_2025', 'hh_priya', 'app_priya_ac', 'tech_ramesh', 'local', 'closed', 'gas_top_up',
   'AC not cooling properly.',
   '2025-04-12 17:00+05:30', '2025-04-11 10:00+05:30', '2025-04-11 10:05+05:30', '2025-04-11 11:30+05:30',
   '2025-04-12 16:55+05:30', '2025-04-12 18:10+05:30'),
  ('job_priya_fridge_wire', 'hh_priya', 'app_priya_fridge', 'tech_ramesh', 'local', 'closed', 'wiring_repair',
   'Fridge light and compressor cutting off; burnt wire at the back.',
   '2025-11-08 11:00+05:30', '2025-11-07 19:00+05:30', '2025-11-07 19:02+05:30', '2025-11-07 20:15+05:30',
   '2025-11-08 11:10+05:30', '2025-11-08 11:50+05:30'),
  ('job_mehta_ac_gas', 'hh_mehta', NULL, 'tech_anil', 'local', 'escalated', 'gas_top_up',
   'AC gas top-up.',
   current_date - 40 + time '15:00', current_date - 41 + time '09:00', current_date - 41 + time '09:00',
   current_date - 41 + time '12:00', current_date - 40 + time '15:20', current_date - 40 + time '16:30'),
  ('job_kulkarni_ac_gas', 'hh_kulkarni', NULL, 'tech_ramesh', 'local', 'closed', 'gas_top_up', 'AC gas top-up.',
   '2025-10-04 11:00+05:30', '2025-10-03 09:00+05:30', NULL, NULL, NULL, '2025-10-04 12:00+05:30'),
  ('job_deshpande_ac_gas', 'hh_deshpande', NULL, 'tech_ramesh', 'local', 'closed', 'gas_top_up', 'AC gas top-up.',
   '2026-05-09 17:00+05:30', '2026-05-08 09:00+05:30', NULL, NULL, NULL, '2026-05-09 18:00+05:30');

INSERT INTO price_ledger (id, household_id, job_id, technician_id, appliance_type, service_type, parts, labour, total, method, reported_by, confirmed, note, paid_at) VALUES
  -- Priya's own history (Tier 3)
  ('pay_priya_ac_gas',    'hh_priya', 'job_priya_ac_gas_2025', 'tech_ramesh', 'ac',     'gas_top_up',    NULL, NULL, 600, 'direct_upi',  'household', true, 'Paid Ramesh by UPI.', '2025-04-12 18:15+05:30'),
  ('pay_priya_fridge',    'hh_priya', 'job_priya_fridge_wire', 'tech_ramesh', 'fridge', 'wiring_repair', 100,  250,  350, 'direct_cash', 'household', true, NULL,                 '2025-11-08 11:55+05:30'),
  -- Neighbours (Tier 2: society average, needs >= 3 data points)
  ('pay_mehta_ac_gas',     'hh_mehta',     'job_mehta_ac_gas',     'tech_anil',   'ac', 'gas_top_up', NULL, NULL, 900, 'direct_cash', 'household', true, NULL, current_date - 40 + time '16:40'),
  ('pay_kulkarni_ac_gas',  'hh_kulkarni',  'job_kulkarni_ac_gas',  'tech_ramesh', 'ac', 'gas_top_up', NULL, NULL, 750, 'direct_upi',  'household', true, NULL, '2025-10-04 12:05+05:30'),
  ('pay_deshpande_ac_gas', 'hh_deshpande', 'job_deshpande_ac_gas', 'tech_ramesh', 'ac', 'gas_top_up', NULL, NULL, 800, 'direct_upi',  'household', true, NULL, '2026-05-09 18:05+05:30'),
  ('pay_mehta_ro',         'hh_mehta',     NULL, 'tech_suresh', 'ro_purifier', 'filter_replacement', 1500, NULL, 1500, 'direct_upi',  'household', true, NULL, '2026-02-14 11:00+05:30'),
  ('pay_kulkarni_ro',      'hh_kulkarni',  NULL, 'tech_suresh', 'ro_purifier', 'filter_replacement', 1350, NULL, 1350, 'direct_cash', 'household', true, NULL, '2026-04-20 11:00+05:30'),
  ('pay_deshpande_ro',     'hh_deshpande', NULL, 'tech_suresh', 'ro_purifier', 'filter_replacement', 1650, NULL, 1650, 'direct_upi',  'household', true, NULL, '2026-07-03 11:00+05:30');

INSERT INTO ratings (id, job_id, household_id, technician_id, on_time, fixed, fair_price, reachable) VALUES
  ('rate_priya_ac',     'job_priya_ac_gas_2025', 'hh_priya',     'tech_ramesh', true,  true,  true,  true),
  ('rate_priya_fridge', 'job_priya_fridge_wire', 'hh_priya',     'tech_ramesh', true,  true,  true,  true),
  ('rate_kulkarni_ac',  'job_kulkarni_ac_gas',   'hh_kulkarni',  'tech_ramesh', true,  true,  true,  true),
  ('rate_deshpande_ac', 'job_deshpande_ac_gas',  'hh_deshpande', 'tech_ramesh', false, true,  true,  true),
  ('rate_mehta_ac',     'job_mehta_ac_gas',      'hh_mehta',     'tech_anil',   true,  false, false, false);

-- Anil's unresolved dispute (with another household, not Priya).
INSERT INTO complaints (id, job_id, household_id, technician_id, kind, description, status, created_at) VALUES
  ('cmp_mehta_anil', 'job_mehta_ac_gas', 'hh_mehta', 'tech_anil', 'repeat_fault',
   'AC stopped cooling again 10 days after the gas top-up. Technician not answering calls.',
   'open', current_date - 30 + time '10:00');

-- RO AMC reminder: Janus should remind Priya a day before Suresh's visit is due.
INSERT INTO checks (id, household_id, job_id, kind, due_at, payload) VALUES
  ('chk_priya_ro_amc', 'hh_priya', NULL, 'amc_visit_reminder',
   (current_date + 1 + time '10:00') AT TIME ZONE 'Asia/Kolkata',
   jsonb_build_object('appliance_id', 'app_priya_ro', 'technician_id', 'tech_suresh', 'visit_due_on', current_date + 2));

-- ───────────────────────── Price reference data ─────────────────────────
-- Labelled "reference data, team-collected". as_of is a placeholder until the teammate sends the full list.

INSERT INTO reference_prices (appliance_type, service_type, city, parts_min, parts_max, labour_min, labour_max, total_min, total_max, source, as_of) VALUES
  -- AC gas: a local technician's top-up and a full gas charge are different jobs with very different prices.
  ('ac',          'gas_top_up',         'Pune', NULL, NULL, NULL, NULL, 700,  850,  'PLACEHOLDER — local top-up range, to be replaced from team calls to Pune technicians', '2026-09-01'),
  ('ac',          'full_gas_charge',    'Pune', NULL, NULL, NULL, NULL, 1500, 2800, 'published prices: LG ₹1,500 (R22 split), LG ₹2,750 (inverter), Urban Company Pune ₹2,800', '2026-10-02'),
  ('ac',          'pcb_replacement',    'Pune', 3500, 4500, NULL, NULL, NULL, NULL, 'reference data, team-collected', '2026-09-01'),
  ('fridge',      'gas_refill',         'Pune', NULL, NULL, NULL, NULL, 800,  1000, 'reference data, team-collected', '2026-09-01'),
  ('ro_purifier', 'filter_replacement', 'Pune', 1200, 1800, NULL, NULL, NULL, NULL, 'reference data, team-collected', '2026-09-01');

INSERT INTO inflation_buffers (kind, annual_pct, note) VALUES
  ('parts',  6.00, 'PLACEHOLDER value — not sourced data. Replace before relying on it.'),
  ('labour', 8.00, 'PLACEHOLDER value — not sourced data. Replace before relying on it.');

-- ───────────────────────── Delhivery mock: known Pune places ─────────────────────────

INSERT INTO delhivery_places (id, name, address_line, locality, city, state, pincode, latitude, longitude, aliases) VALUES
  ('plc_sai_heights',  'Sai Heights',              'Sai Heights, Baner Road, Baner',               'Baner',     'Pune', 'Maharashtra', '411045', 18.5603, 73.7812, '{"sai heights","sai hts"}'),
  ('plc_baner_rd',     'Baner Road',               'Baner Road, near Baner Gaon, Baner',           'Baner',     'Pune', 'Maharashtra', '411045', 18.5590, 73.7868, '{"baner gaon","baner"}'),
  ('plc_balewadi_hs',  'Balewadi High Street',     'Balewadi High Street, Balewadi',               'Balewadi',  'Pune', 'Maharashtra', '411045', 18.5705, 73.7790, '{"high street","balewadi"}'),
  ('plc_aundh_iti',    'ITI Road, Aundh',          'ITI Road, Aundh',                              'Aundh',     'Pune', 'Maharashtra', '411007', 18.5580, 73.8075, '{"aundh","iti road"}'),
  ('plc_pashan',       'Pashan-Sus Road',          'Pashan-Sus Road, Pashan',                      'Pashan',    'Pune', 'Maharashtra', '411021', 18.5362, 73.7950, '{"pashan","sus road"}'),
  ('plc_hinjewadi_p1', 'Hinjewadi Phase 1',        'Rajiv Gandhi Infotech Park, Phase 1, Hinjewadi','Hinjewadi', 'Pune', 'Maharashtra', '411057', 18.5913, 73.7389, '{"hinjewadi","phase 1"}'),
  ('plc_kothrud',      'Karve Road, Kothrud',      'Karve Road, Kothrud',                          'Kothrud',   'Pune', 'Maharashtra', '411038', 18.5074, 73.8077, '{"kothrud","karve road"}');

-- ───────────────────────── Custom capabilities data ─────────────────────────

INSERT INTO technician_directory (id, name, business_name, phone, skills, address, latitude, longitude, rating) VALUES
  ('dir_mahesh',  'Mahesh Pawar',   'Shree Sai Cooling Services',        '+919000000021', '{ac,fridge}',                  'Shop 3, Balewadi High Street, Balewadi, Pune 411045', 18.5712, 73.7795, 4.3),
  ('dir_vikas',   'Vikas Shinde',   'Aqua Care RO Services',              '+919000000022', '{ro_purifier}',                'Pashan-Sus Road, Pashan, Pune 411021',               18.5370, 73.7941, 4.1),
  ('dir_santosh', 'Santosh Jadhav', 'Om Electricals & Appliance Repair',  '+919000000023', '{washing_machine,fridge,ac}',   'ITI Road, Aundh, Pune 411007',                       18.5585, 73.8068, 3.9);

-- Pine Labs KYC'd merchants. Anil is deliberately NOT here (not_found).
-- Santosh's phone is registered under a different legal name (mismatch).
INSERT INTO pine_merchants (merchant_id, legal_name, display_name, phone, upi_id, kyc_status, city, onboarded_at) VALUES
  ('PLM100231', 'Ramesh Patil',  'Ramesh Cooling Works',    '+919000000011', 'ramesh.cooling@okaxis', 'verified', 'Pune', '2023-02-11'),
  ('PLM100487', 'Suresh More',   'Suresh RO Care',          '+919000000012', 'suresh.ro@ybl',         'verified', 'Pune', '2022-11-03'),
  ('PLM100912', 'Mahesh Pawar',  'Shree Sai Cooling',       '+919000000021', 'shreesaicooling@okhdfcbank', 'verified', 'Pune', '2024-06-19'),
  ('PLM101377', 'Sunil Jadhav',  'Om Electricals',          '+919000000023', 'omelectricals@okicici', 'verified', 'Pune', '2024-01-08');

-- ───────────────────────── Pine Labs mock: payout balance ─────────────────────────
-- ₹2,000 so that a ₹2,500 payout fails with INSUFFICIENT_BALANCE.

INSERT INTO merchant_balance (merchant_id, balance) VALUES ('janus_merchant', 2000);
