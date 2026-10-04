// WhatsApp pacing: the Twilio sandbox allows about one message every 3 seconds, so every send on this server
// instance takes the next free slot, at least 3.5 s after the previous one. Sends are never made in parallel.
import { AsyncLocalStorage } from "node:async_hooks";

export const SEND_GAP_MS = 3500;
export const SEND_COST_MS = 1500; // one Twilio request + the 1 s delivery-status look
let nextSlot = 0;

// Books the next send slot and returns how many ms to wait before sending.
export function reserveSlot(): number {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + SEND_GAP_MS;
  return at - now;
}

// How long a send booked now would wait (without booking it).
export const waitForSlot = () => Math.max(0, nextSlot - Date.now());

// Time limit for sends made inside one tool call (a step tool sets it so the whole tool stays under 10 s).
export const sendDeadline = new AsyncLocalStorage<number>();

// Phones used by the test suites (+917000000…): paced like real sends but never sent to Twilio.
export const isTestNumber = (phone: string) => phone.startsWith("+917000000");
