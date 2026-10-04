-- Step tools: the technician's quoted bill is saved on the job (bill_reported). Non-destructive.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quoted_amount integer;
