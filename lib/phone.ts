import { z } from "zod";
import { ToolError } from "./mcp";

export const PHONE_HINT =
  "Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix.";

export const zPhone = z.string().min(5).describe(PHONE_HINT);

// '+91 98765-43210', '09876543210', 'whatsapp:+919876543210', '9876543210' → '+919876543210'
export function normalizePhone(raw: string): string | null {
  let p = raw.trim().replace(/^whatsapp:/i, "").replace(/[\s\-().]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^\d{10}$/.test(p)) p = "+91" + p;
  else if (/^0\d{10}$/.test(p)) p = "+91" + p.slice(1);
  else if (/^91\d{10}$/.test(p)) p = "+" + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

export function phoneOrFail(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw new ToolError("INVALID_PHONE", `"${raw}" is not a valid phone number. Use E.164 like +919876543210.`);
  return phone;
}
