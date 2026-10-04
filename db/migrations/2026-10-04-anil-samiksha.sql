-- Anil (tech_anil) is now played by Samiksha: real phone, available AC technician for hh_priya, verified Pine Labs
-- merchant. Same as the updated db/seed.sql, applied to the live database WITHOUT a reset. Safe to run twice.
UPDATE technicians
SET phone = '+919823562151', contact_pref = 'text', opted_in = true, availability_status = 'available',
    upi_id = 'anil.kale@okicici', updated_at = now()
WHERE id = 'tech_anil';

-- Ramesh keeps appearing first (Priya's regular since Apr 2025), then Anil.
UPDATE household_technicians SET added_at = '2025-04-10 10:00+05:30' WHERE household_id = 'hh_priya' AND technician_id = 'tech_ramesh';
UPDATE household_technicians SET added_at = '2022-08-02 10:00+05:30' WHERE household_id = 'hh_priya' AND technician_id = 'tech_suresh';
INSERT INTO household_technicians (household_id, technician_id, appliance_types, relationship, note, added_at)
VALUES ('hh_priya', 'tech_anil', '{ac}', 'known', 'Second AC technician; Priya got his number from the Sai Heights group.', current_date - 3)
ON CONFLICT (household_id, technician_id) DO UPDATE
SET appliance_types = EXCLUDED.appliance_types, relationship = EXCLUDED.relationship, note = EXCLUDED.note, added_at = EXCLUDED.added_at;

INSERT INTO pine_merchants (merchant_id, legal_name, display_name, phone, upi_id, kyc_status, city, onboarded_at)
VALUES ('PLM101588', 'Anil Kale', 'Anil AC Services', '+919823562151', 'anil.kale@okicici', 'verified', 'Pune', '2024-03-12')
ON CONFLICT (merchant_id) DO UPDATE
SET legal_name = EXCLUDED.legal_name, display_name = EXCLUDED.display_name, phone = EXCLUDED.phone,
    upi_id = EXCLUDED.upi_id, kyc_status = EXCLUDED.kyc_status;
