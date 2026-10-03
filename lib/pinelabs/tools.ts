// Pine Labs Online mock: One-Time Mandate, UPI AutoPay (fixed-frequency subscriptions) and Payouts.
// Fields are copied from Pine Labs' OpenAPI spec (pinelabs.com/docs/online-payments/api/downloads/openapi-spec)
// and the One-Time Mandate integration guide. Amounts are in PAISE, exactly like Pine Labs (₹1 = 100).
// See MOCKS.md for what is verified and what is assumed.
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { addMockTool, type MockReply } from "@/lib/mcp";
import { sleep, takeScenario, TIMEOUT_DELAY_MS } from "@/lib/scenarios";

const OTM_MAX_PAISE = 10_000_000; // ₹1,00,000 per One-Time Mandate
const OTM_MAX_DAYS = 60;
const MIN_PAISE = 100;
const MAX_PAISE = 100_000_000; // ₹10 lakh, Pine Labs' documented amount ceiling

type Json = Record<string, unknown>;
const ok = (body: unknown, status = 200): MockReply => ({ status, body });
// Pine Labs' documented error shape.
const plError = (status: number, code: string, message: string, reason: string, step = "request_validation"): MockReply => ({
  status,
  body: { code, message, additional_error_details: { source: "INTERNAL", step, reason } },
});
const invalid = (reason: string, message = "The request does not meet the expected contract and cannot be processed. This may be due to malformed request, invalid or missing parameters") =>
  plError(400, "INVALID_REQUEST", message, reason);
const duplicate = (reason: string) => plError(409, "DUPLICATE_REQUEST", "The request has already been processed", reason);
const timeoutReply = () =>
  plError(504, "GATEWAY_TIMEOUT", "The request timed out while waiting for an upstream response", "upstream_timeout", "request_processing");
const malformed = (text: string): MockReply => ({ malformed: text });

const amountSchema = z.object({ value: z.number().int(), currency: z.literal("INR") });
const now = () => new Date().toISOString();
const stamp = () => new Date().toISOString().slice(2, 19).replace(/[-T:]/g, ""); // YYMMDDhhmmss, as in Pine Labs ids
const suffix = (n = 6) => randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, n);
const newId = (prefix: string) => `${prefix}-${stamp()}-aa-${suffix()}`;
const hex32 = () => randomBytes(16).toString("hex");
const checkAmount = (value: number) => value >= MIN_PAISE && value <= MAX_PAISE;

// Applies a failure switch if it is set to "timeout" or one of the values in `apply`; other values are left
// untouched for the step that handles them.
async function onScenario(key: string, apply: Record<string, () => MockReply | Promise<MockReply>>): Promise<MockReply | null> {
  const value = await takeScenario(key, ["timeout", ...Object.keys(apply)]);
  if (!value) return null;
  if (value === "timeout") {
    await sleep(TIMEOUT_DELAY_MS);
    return timeoutReply();
  }
  return apply[value] ? apply[value]() : null;
}

async function getSubscription(id: string) {
  const [row] = await sql`SELECT * FROM mock_pl_subscriptions WHERE subscription_id = ${id}`;
  if (!row) return null;
  // A mandate past its validity that was never used expires, like the real one.
  if (row.valid_until && new Date(row.valid_until as string) < new Date() && ["CREATED", "ACTIVE"].includes(row.status as string)) {
    await saveSubscription(row.subscription_id as string, "EXPIRED", row.body as Json);
    return { ...row, status: "EXPIRED", body: { ...(row.body as Json), status: "EXPIRED" } };
  }
  return row;
}

async function saveSubscription(id: string, status: string, body: Json) {
  const updated = { ...body, status, modified_at: now() };
  await sql`UPDATE mock_pl_subscriptions SET status = ${status}, body = ${JSON.stringify(updated)}::jsonb, updated_at = now() WHERE subscription_id = ${id}`;
  return updated;
}

export function registerPineLabsTools(server: McpServer) {
  const badInput = () => invalid("missing_required_fields");

  // ───────────────────────── Customers ─────────────────────────
  addMockTool(
    server,
    "create_customer",
    "Pine Labs POST /api/v1/customer. Creates the customer a mandate or subscription is set up for. Returns customer_id. (Priya already exists: cust-v1-250901101500-aa-PRIYA1, merchant_customer_reference 'hh_priya'.)",
    z.object({
      merchant_customer_reference: z.string().min(1),
      first_name: z.string().min(1),
      last_name: z.string().optional(),
      country_code: z.string().default("91"),
      mobile_number: z.string().regex(/^\d{10}$/),
      email_id: z.string().optional(),
      merchant_metadata: z.record(z.string(), z.string()).optional(),
    }),
    async (a) => {
      const [existing] = await sql`SELECT body FROM mock_pl_customers WHERE merchant_customer_reference = ${a.merchant_customer_reference}`;
      if (existing) return ok(existing.body, 200);
      const customer_id = `cust-v1-${stamp()}-aa-${suffix()}`;
      const body = {
        customer_id, merchant_customer_reference: a.merchant_customer_reference, first_name: a.first_name,
        last_name: a.last_name ?? "", country_code: a.country_code, mobile_number: a.mobile_number, email_id: a.email_id ?? null,
        gstin: null, merchant_metadata: a.merchant_metadata ?? {}, status: "ACTIVE", created_at: now(), updated_at: now(),
      };
      await sql`INSERT INTO mock_pl_customers (customer_id, merchant_customer_reference, body) VALUES (${customer_id}, ${a.merchant_customer_reference}, ${JSON.stringify(body)}::jsonb)`;
      return ok(body, 201);
    },
    badInput,
  );

  // ───────────────────────── One-Time Mandate ─────────────────────────
  addMockTool(
    server,
    "create_ot_subscription",
    `Pine Labs One-Time Mandate, step 1: POST /api/v1/public/subscriptions/ot. Blocks up to plan_details.amount (PAISE: ₹2,500 = 250000) on the customer's UPI for validity_days, to be debited once later. Limits: max ₹1,00,000 (10000000 paise), max ${OTM_MAX_DAYS} days. merchant_subscription_reference is the idempotency key. Returns subscription_id, order_id, status CREATED; next call create_mandate_payment with the order_id.`,
    z.object({
      merchant_subscription_reference: z.string().min(1),
      customer_id: z.string().min(1),
      plan_details: z.object({
        amount: z.number().int(),
        currency: z.literal("INR").default("INR"),
        validity_days: z.number().int(),
        description: z.string().optional(),
      }),
      callback_url: z.string().optional(),
      merchant_metadata: z.record(z.string(), z.string()).optional(),
    }),
    async (a) => {
      const sw = await onScenario("pinelabs.next_mandate", {
        malformed: () => malformed(`{"subscription_id": "v1-sub-${stamp()}-aa-`),
        limit_exceeded: () => invalid("amount_exceeds_limit", "One-Time Mandate amount exceeds the permitted limit of INR 1,00,000"),
      });
      if (sw) return sw;
      const [dup] = await sql`SELECT 1 FROM mock_pl_subscriptions WHERE merchant_subscription_reference = ${a.merchant_subscription_reference}`;
      if (dup) return plError(422, "DUPLICATE_REQUEST", "The request has already been processed", "duplicate_merchant_subscription_reference");
      const [customer] = await sql`SELECT 1 FROM mock_pl_customers WHERE customer_id = ${a.customer_id}`;
      if (!customer) return plError(404, "CUSTOMER_NOT_FOUND", "Customer not found", "resource_does_not_exist", "resource_lookup");
      if (a.plan_details.amount < MIN_PAISE) return invalid("invalid_amount", "Amount must be at least INR 1 (100 paise)");
      if (a.plan_details.amount > OTM_MAX_PAISE) return invalid("amount_exceeds_limit", "One-Time Mandate amount exceeds the permitted limit of INR 1,00,000");
      if (a.plan_details.validity_days < 1 || a.plan_details.validity_days > OTM_MAX_DAYS) {
        return invalid("invalid_validity", `validity_days must be between 1 and ${OTM_MAX_DAYS}`);
      }

      const subscription_id = newId("v1-sub");
      const order_id = newId("v1");
      const start = new Date();
      const end = new Date(start.getTime() + a.plan_details.validity_days * 86_400_000);
      const body = {
        subscription_id, order_id, merchant_subscription_reference: a.merchant_subscription_reference, customer_id: a.customer_id,
        plan_details: { amount: a.plan_details.amount, currency: a.plan_details.currency, validity_days: a.plan_details.validity_days, description: a.plan_details.description ?? null },
        frequency: "OT", execution_mode: "DIRECT_EXECUTION", status: "CREATED",
        start_date: start.toISOString(), end_date: end.toISOString(),
        callback_url: a.callback_url ?? null, merchant_metadata: a.merchant_metadata ?? {}, created_at: now(), modified_at: now(),
      };
      await sql`
        INSERT INTO mock_pl_subscriptions (subscription_id, merchant_subscription_reference, order_id, kind, status, max_amount_paise, valid_until, body)
        VALUES (${subscription_id}, ${a.merchant_subscription_reference}, ${order_id}, 'OT', 'CREATED', ${a.plan_details.amount}, ${end.toISOString()}, ${JSON.stringify(body)}::jsonb)`;
      return ok(body, 201);
    },
    badInput,
  );

  addMockTool(
    server,
    "get_ot_subscription",
    "Pine Labs GET /api/v1/subscriptions/ot/{subscription_id}. Status of a One-Time Mandate: CREATED (waiting for the customer to approve), ACTIVE (approved, can be debited once), COMPLETED (debited), CANCELLED, EXPIRED.",
    z.object({ subscription_id: z.string().min(1) }),
    async ({ subscription_id }) => {
      const row = await getSubscription(subscription_id);
      if (!row || row.kind !== "OT") return plError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found", "resource_does_not_exist", "resource_lookup");
      return ok(row.body);
    },
    badInput,
  );

  addMockTool(
    server,
    "create_mandate_payment",
    "Pine Labs POST /api/pay/v1/orders/{order_id}/payments with mandate_info.request_type CREATE_MANDATE. Registers the UPI mandate for a One-Time Mandate or a UPI AutoPay subscription (use its order_id). payment_amount.value (paise) must equal the mandate amount. In this mock the customer approves in their UPI app immediately: the mandate/subscription becomes ACTIVE (unless the 'declined' failure switch is on).",
    z.object({
      order_id: z.string().min(1),
      payments: z
        .array(
          z.object({
            merchant_payment_reference: z.string().min(1),
            payment_method: z.literal("UPI").default("UPI"),
            payment_amount: amountSchema,
            payment_option: z.object({ upi_details: z.object({ txn_mode: z.enum(["COLLECT", "INTENT"]), payer: z.object({ vpa: z.string() }).partial().optional() }) }).optional(),
            mandate_info: z.object({ request_type: z.literal("CREATE_MANDATE") }),
          }),
        )
        .length(1),
    }),
    async ({ order_id, payments }) => {
      const [row] = await sql`SELECT * FROM mock_pl_subscriptions WHERE order_id = ${order_id}`;
      if (!row) return plError(404, "ORDER_NOT_FOUND", "Order not found", "resource_does_not_exist", "resource_lookup");
      const p = payments[0];
      const switchKey = row.kind === "OT" ? "pinelabs.next_mandate" : "pinelabs.next_subscription";
      const scenario = await takeScenario(switchKey, ["declined", "timeout", "malformed"]);
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return timeoutReply();
      }
      if (scenario === "malformed") return malformed(`{"data": {"order_id": "${order_id}", "status": "AUTHO`);
      if (row.status !== "CREATED") return invalid("mandate_already_processed", `Mandate is already ${row.status}`);
      const planAmount = row.kind === "OT" ? (row.body as Json & { plan_details: { amount: number } }).plan_details.amount : (row.body as Json & { order_amount: { value: number } }).order_amount.value;
      if (p.payment_amount.value !== planAmount) {
        return invalid("amount_mismatch", `payment_amount.value (${p.payment_amount.value}) must match the mandate amount (${planAmount})`);
      }

      const declined = scenario === "declined";
      const payment = {
        id: `${order_id}-up-${suffix(1)}`,
        merchant_payment_reference: p.merchant_payment_reference,
        status: declined ? "FAILED" : "AUTHORIZED",
        payment_amount: p.payment_amount,
        payment_method: "UPI",
        payment_option: { upi_details: { txn_mode: p.payment_option?.upi_details.txn_mode ?? "INTENT", payer: p.payment_option?.upi_details.payer ?? null } },
        ...(declined ? { error_detail: { code: "PAYMENT_DECLINED", message: "Customer declined the mandate request in the UPI app" } } : {}),
        created_at: now(),
        updated_at: now(),
      };
      if (!declined) await saveSubscription(row.subscription_id as string, "ACTIVE", row.body as Json);
      return ok({
        data: {
          order_id,
          merchant_order_reference: row.merchant_subscription_reference,
          type: "CHARGE",
          status: declined ? "FAILED" : "AUTHORIZED",
          order_amount: { value: planAmount, currency: "INR" },
          pre_auth: false,
          allowed_payment_methods: ["UPI"],
          payments: [payment],
          created_at: row.created_at,
          updated_at: now(),
          integration_mode: "SEAMLESS",
        },
      });
    },
    badInput,
  );

  addMockTool(
    server,
    "create_presentation",
    "Pine Labs POST /ps/api/v1/public/subscriptions/{subscription_id}/presentations. Debits the customer against an ACTIVE mandate/subscription (the 'capture'). amount.value in PAISE must be ≤ the mandate amount. A One-Time Mandate can be debited only once and then becomes COMPLETED. merchant_presentation_reference must be unique (a repeat returns DUPLICATE_REQUEST, never a second debit).",
    z.object({
      subscription_id: z.string().min(1),
      amount: amountSchema,
      merchant_presentation_reference: z.string().min(1),
      due_date: z.string().optional(),
    }),
    async (a) => {
      const row = await getSubscription(a.subscription_id);
      if (!row) return plError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found", "resource_does_not_exist", "resource_lookup");
      const [dup] = await sql`SELECT 1 FROM mock_pl_presentations WHERE merchant_presentation_reference = ${a.merchant_presentation_reference}`;
      if (dup) return duplicate("duplicate_merchant_presentation_reference");
      if (row.status !== "ACTIVE") return invalid("subscription_not_active", `Subscription is ${row.status}; only ACTIVE subscriptions can be debited`);
      if (!checkAmount(a.amount.value)) return invalid("invalid_amount", "Amount must be between INR 1 and INR 10,00,000");
      if (a.amount.value > (row.max_amount_paise as number)) {
        return invalid("amount_exceeds_mandate", `amount.value (${a.amount.value}) exceeds the subscription maximum limit (${row.max_amount_paise})`);
      }

      const presentation_id = newId("v1-bil");
      const due = a.due_date ?? now();
      const created = { subscription_id: a.subscription_id, presentation_id, due_date: due, amount: a.amount, status: "CREATED", merchant_presentation_reference: a.merchant_presentation_reference };
      // The bank completes the debit right away in the mock; fetching it shows COMPLETED.
      const stored = { ...created, pdn_status: "NOTIFIED", status: "COMPLETED", failure_count: 0, order_id: newId("v1") };
      await sql`
        INSERT INTO mock_pl_presentations (presentation_id, subscription_id, merchant_presentation_reference, status, amount_paise, body)
        VALUES (${presentation_id}, ${a.subscription_id}, ${a.merchant_presentation_reference}, 'COMPLETED', ${a.amount.value}, ${JSON.stringify(stored)}::jsonb)`;
      if (row.kind === "OT") await saveSubscription(a.subscription_id, "COMPLETED", row.body as Json);
      return ok(created, 201);
    },
    badInput,
  );

  addMockTool(
    server,
    "get_presentation",
    "Pine Labs GET /ps/api/v1/public/presentations/{presentation_id}. Debit status: CREATED, PENDING, COMPLETED, FAILED, CANCELLED…, plus pdn_status (pre-debit notification) and failure_count.",
    z.object({ presentation_id: z.string().min(1) }),
    async ({ presentation_id }) => {
      const [row] = await sql`SELECT body FROM mock_pl_presentations WHERE presentation_id = ${presentation_id}`;
      if (!row) return plError(404, "ORDER_NOT_FOUND", "Order not found", "resource_does_not_exist", "resource_lookup");
      return ok(row.body);
    },
    badInput,
  );

  addMockTool(
    server,
    "cancel_subscription",
    "Pine Labs POST /ps/api/v1/public/subscriptions/{subscription_id}/cancel. Revokes a One-Time Mandate or cancels a UPI AutoPay subscription; it can no longer be debited. Returns the subscription with status CANCELLED.",
    z.object({ subscription_id: z.string().min(1) }),
    async ({ subscription_id }) => {
      const row = await getSubscription(subscription_id);
      if (!row) return plError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found", "resource_does_not_exist", "resource_lookup");
      if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(row.status as string)) {
        return invalid("subscription_not_cancellable", `Subscription is already ${row.status}`);
      }
      return ok(await saveSubscription(subscription_id, "CANCELLED", row.body as Json));
    },
    badInput,
  );

  // ───────────────────────── UPI AutoPay (fixed-frequency subscriptions) ─────────────────────────
  addMockTool(
    server,
    "create_plan",
    "Pine Labs POST /ps/api/v1/public/plans. A recurring plan (frequency Month, Quarterly, …) with amount and max_limit_amount in PAISE. (Seeded: v1-pla-250901101600-aa-ROAMC1 = Kent RO AMC, ₹500 quarterly.)",
    z.object({
      plan_name: z.string().min(1),
      plan_description: z.string().optional(),
      frequency: z.enum(["Day", "Week", "Month", "Year", "Bi-Monthly", "Quarterly", "Half-Yearly", "AS", "OT", "Not Applicable"]),
      amount: amountSchema,
      max_limit_amount: amountSchema,
      initial_debit_amount: amountSchema.optional(),
      trial_period_in_days: z.number().int().min(0).optional(),
      start_date: z.string().optional(),
      end_date: z.string(),
      merchant_plan_reference: z.string().min(1),
      merchant_metadata: z.record(z.string(), z.string()).optional(),
      auto_debit_ot: z.string().optional(),
    }),
    async (a) => {
      const [dup] = await sql`SELECT 1 FROM mock_pl_plans WHERE merchant_plan_reference = ${a.merchant_plan_reference}`;
      if (dup) return plError(422, "DUPLICATE_REQUEST", "The request has already been processed", "duplicate_merchant_plan_reference");
      if (!checkAmount(a.amount.value) || a.max_limit_amount.value < a.amount.value) return invalid("invalid_amount");
      const plan_id = newId("v1-pla");
      const body = {
        plan_id, status: "ACTIVE", plan_name: a.plan_name, plan_description: a.plan_description ?? "", frequency: a.frequency,
        amount: a.amount, max_limit_amount: a.max_limit_amount, trial_period_in_days: a.trial_period_in_days ?? 0,
        start_date: a.start_date ?? now(), end_date: a.end_date, merchant_metadata: a.merchant_metadata ?? {},
        merchant_plan_reference: a.merchant_plan_reference, created_at: now(), modified_at: now(),
        initial_debit_amount: a.initial_debit_amount ?? a.amount, auto_debit_ot: a.auto_debit_ot ?? "false",
      };
      await sql`INSERT INTO mock_pl_plans (plan_id, merchant_plan_reference, body) VALUES (${plan_id}, ${a.merchant_plan_reference}, ${JSON.stringify(body)}::jsonb)`;
      return ok(body, 201);
    },
    badInput,
  );

  addMockTool(
    server,
    "create_subscription",
    "Pine Labs POST /ps/api/v1/public/subscriptions (UPI AutoPay / fixed frequency). Subscribes a customer to a plan; merchant_subscription_reference is the idempotency key. Returns subscription_id and order_id with status CREATED; then call create_mandate_payment with that order_id and order_amount.value to activate it.",
    z.object({
      merchant_subscription_reference: z.string().min(1),
      plan_id: z.string().min(1),
      customer_id: z.string().min(1),
      start_date: z.string(),
      end_date: z.string(),
      integration_mode: z.enum(["SEAMLESS", "REDIRECT"]),
      enable_notification: z.boolean().optional(),
      allowed_payment_methods: z.array(z.string()).optional(),
      merchant_metadata: z.record(z.string(), z.string()).optional(),
      callback_url: z.string().optional(),
      failure_callback_url: z.string().optional(),
    }),
    async (a) => {
      const sw = await onScenario("pinelabs.next_subscription", {
        malformed: () => malformed(`{"order_id": "v1-${stamp()}-aa-`),
      });
      if (sw) return sw;
      const [dup] = await sql`SELECT 1 FROM mock_pl_subscriptions WHERE merchant_subscription_reference = ${a.merchant_subscription_reference}`;
      if (dup) return plError(422, "DUPLICATE_REQUEST", "The request has already been processed", "duplicate_merchant_subscription_reference");
      const [plan] = await sql`SELECT body FROM mock_pl_plans WHERE plan_id = ${a.plan_id}`;
      if (!plan) return plError(404, "PLAN_NOT_FOUND", "Plan not found", "resource_does_not_exist", "resource_lookup");
      const [customer] = await sql`SELECT 1 FROM mock_pl_customers WHERE customer_id = ${a.customer_id}`;
      if (!customer) return plError(404, "CUSTOMER_NOT_FOUND", "Customer not found", "resource_does_not_exist", "resource_lookup");
      if (Number.isNaN(Date.parse(a.start_date)) || Number.isNaN(Date.parse(a.end_date)) || Date.parse(a.end_date) <= Date.parse(a.start_date)) {
        return invalid("invalid_dates", "end_date must be after start_date (ISO 8601 UTC)");
      }

      const planBody = plan.body as Json & { max_limit_amount: { value: number }; initial_debit_amount?: { value: number } };
      const subscription_id = newId("v1-sub");
      const order_id = newId("v1");
      const body = {
        callback_url: a.callback_url ?? null, failure_callback_url: a.failure_callback_url ?? null,
        redirect_url: a.integration_mode === "REDIRECT" ? `https://api.pluralonline.com/api/v3/checkout-bff/redirect/checkout?token=V3_${suffix(24)}&subscription_id=${subscription_id}` : null,
        order_id, subscription_id, merchant_subscription_reference: a.merchant_subscription_reference,
        enable_notification: a.enable_notification ?? true, plan_details: planBody, quantity: 1,
        start_date: a.start_date, end_date: a.end_date, customer_id: a.customer_id, payment_mode: null,
        allowed_payment_methods: a.allowed_payment_methods ?? ["UPI"], integration_mode: a.integration_mode,
        merchant_metadata: a.merchant_metadata ?? {}, status: "CREATED", is_tpv_enabled: false,
        bank_account: { account_number: null, name: null, ifsc: null }, created_at: now(), modified_at: now(),
        order_amount: { value: planBody.initial_debit_amount?.value ?? planBody.max_limit_amount.value, currency: "INR" },
      };
      await sql`
        INSERT INTO mock_pl_subscriptions (subscription_id, merchant_subscription_reference, order_id, kind, status, max_amount_paise, valid_until, body)
        VALUES (${subscription_id}, ${a.merchant_subscription_reference}, ${order_id}, 'RECURRING', 'CREATED', ${planBody.max_limit_amount.value}, ${a.end_date}, ${JSON.stringify(body)}::jsonb)`;
      return ok(body, 201);
    },
    badInput,
  );

  addMockTool(
    server,
    "get_subscription",
    "Pine Labs GET /ps/api/v1/public/subscriptions/{subscription_id}. A UPI AutoPay subscription with its plan_details and status (CREATED, ACTIVE, CANCELLED, EXPIRED, …).",
    z.object({ subscription_id: z.string().min(1) }),
    async ({ subscription_id }) => {
      const row = await getSubscription(subscription_id);
      if (!row) return plError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found", "resource_does_not_exist", "resource_lookup");
      return ok(row.body);
    },
    badInput,
  );

  // ───────────────────────── Payouts ─────────────────────────
  addMockTool(
    server,
    "create_payout",
    "Pine Labs POST /payouts/v3/payments/banks. Pays a beneficiary (e.g. the technician) from the merchant funding account. mode UPI needs vpa; IMPS/NEFT/RTGS need accountNumber + branchCode (IFSC). amount.value in PAISE. clientReferenceId is the idempotency key: a repeat returns 409 DUPLICATE_REQUEST and never pays twice. If the funding account balance is too low, the payout is accepted with status PENDING ('Funding account has insufficient balance') and no money moves. Check progress with get_payouts.",
    z.object({
      clientReferenceId: z.string().min(1),
      payeeName: z.string().min(1),
      email: z.string().optional(),
      phone: z.string().optional(),
      accountNumber: z.string().optional(),
      branchCode: z.string().optional(),
      vpa: z.string().optional(),
      amount: amountSchema,
      mode: z.enum(["UPI", "IMPS", "NEFT", "RTGS"]),
      remarks: z.string().min(1),
    }),
    async (a) => {
      if (/\s/.test(a.clientReferenceId)) return invalid("invalid_client_reference_id", "clientReferenceId must not contain spaces");
      const [dup] = await sql`SELECT 1 FROM mock_pl_payouts WHERE client_reference_id = ${a.clientReferenceId}`;
      if (dup) return duplicate("duplicate_reference");
      if (!/^[A-Za-z ]+$/.test(a.payeeName)) return invalid("invalid_payee_name", "payeeName may contain alphabets and spaces only");
      if (!/^[A-Za-z0-9\- ]+$/.test(a.remarks)) return invalid("invalid_remarks", "remarks may contain A-Z, a-z, 0-9, hyphen and space only");
      if (a.phone && !/^\d{10}$/.test(a.phone)) return invalid("invalid_phone", "phone must be 10 numeric digits");
      if (a.mode === "UPI" && !a.vpa) return invalid("missing_required_fields", "vpa is required for UPI payouts");
      if (a.mode !== "UPI") {
        if (!a.accountNumber || !a.branchCode) return invalid("missing_required_fields", "accountNumber and branchCode are required for IMPS, NEFT and RTGS");
        if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(a.branchCode)) return invalid("invalid_branch_code", "branchCode must be a valid IFSC");
      }
      if (!checkAmount(a.amount.value)) return invalid("invalid_amount", "Amount must be between INR 1 and INR 10,00,000");

      const scenario = await takeScenario("pinelabs.next_payout");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return timeoutReply();
      }
      if (scenario === "malformed") return malformed(`{"clientReferenceId": "${a.clientReferenceId}", "status": "SCHED`);
      return createPayout(a, scenario === "insufficient_balance" ? "PENDING" : scenario === "failed" ? "FAILED" : null);
    },
    badInput,
  );

  addMockTool(
    server,
    "get_payouts",
    "Pine Labs GET /payouts/v3/payments. Look up payouts by paymentReferenceId or clientReferenceId (or list by status). Status: SCHEDULED, PENDING (insufficient balance), PROCESSING, PROCESSED, SUCCESS (with bankTransactionReferenceId = UTR), FAILED.",
    z.object({
      paymentReferenceId: z.string().optional(),
      clientReferenceId: z.string().optional(),
      status: z.enum(["SCHEDULED", "PENDING", "PROCESSING", "PROCESSED", "SUCCESS", "FAILED"]).optional(),
      page: z.number().int().min(1).default(1),
      count: z.number().int().min(1).max(500).default(500),
    }),
    async (a) => {
      const rows = await sql`
        SELECT body FROM mock_pl_payouts
        WHERE (${a.paymentReferenceId ?? null}::text IS NULL OR payment_reference_id = ${a.paymentReferenceId ?? null})
          AND (${a.clientReferenceId ?? null}::text IS NULL OR client_reference_id = ${a.clientReferenceId ?? null})
          AND (${a.status ?? null}::text IS NULL OR status = ${a.status ?? null})
        ORDER BY created_at DESC`;
      const start = (a.page - 1) * a.count;
      const pageRows = rows.slice(start, start + a.count).map((r) => r.body);
      const totalPages = Math.max(1, Math.ceil(rows.length / a.count));
      const query = new URLSearchParams({ page: "1", count: String(a.count), ...(a.paymentReferenceId ? { paymentReferenceId: a.paymentReferenceId } : {}), ...(a.clientReferenceId ? { clientReferenceId: a.clientReferenceId } : {}) });
      return ok({ payments: pageRows, totalRecords: rows.length, nextPage: Math.min(a.page + 1, totalPages), totalPages, _links: [{ rel: "first", href: `/payouts/v3/payments?${query}` }] });
    },
    badInput,
  );

  addMockTool(
    server,
    "get_payout_balance",
    "Pine Labs GET /payouts/v3/payments/funding-account. The merchant funding account payouts are paid from: accountNumber, branchCode, balance.value in PAISE (₹2,000 at reset = 200000).",
    z.object({}),
    async () => {
      const [b] = await sql`SELECT * FROM merchant_balance WHERE merchant_id = 'janus_merchant'`;
      return ok({ accountNumber: b.account_number, branchCode: b.branch_code, balance: { currency: "INR", value: Number(b.balance_paise) } });
    },
    badInput,
  );
}

type PayoutInput = {
  clientReferenceId: string; payeeName: string; accountNumber?: string; branchCode?: string; vpa?: string;
  amount: { value: number; currency: "INR" }; mode: "UPI" | "IMPS" | "NEFT" | "RTGS"; remarks: string;
};

// Pays from the funding account. Not enough balance → PENDING (no money moves), as Pine Labs documents.
async function createPayout(a: PayoutInput, forcedStatus: "PENDING" | "FAILED" | null): Promise<MockReply> {
  const paymentReferenceId = `txn-${hex32()}`;
  const requestReferenceId = `req-${hex32()}`;
  const masked = a.accountNumber ? `${"*".repeat(Math.max(0, a.accountNumber.length - 4))}${a.accountNumber.slice(-4)}` : undefined;

  // Deduct atomically only if the balance covers it.
  let paid = false;
  if (!forcedStatus) {
    const [deducted] = await sql`
      UPDATE merchant_balance SET balance_paise = balance_paise - ${a.amount.value}, updated_at = now()
      WHERE merchant_id = 'janus_merchant' AND balance_paise >= ${a.amount.value}
      RETURNING balance_paise`;
    paid = Boolean(deducted);
  }
  const finalStatus = forcedStatus ?? (paid ? "SUCCESS" : "PENDING");
  const created = {
    clientReferenceId: a.clientReferenceId, requestReferenceId, paymentReferenceId, payeeName: a.payeeName,
    ...(masked ? { accountNumber: masked, branchCode: a.branchCode } : {}), ...(a.vpa ? { vpa: a.vpa } : {}),
    amount: a.amount, mode: a.mode,
    status: finalStatus === "SUCCESS" ? "SCHEDULED" : finalStatus,
    message: finalStatus === "PENDING" ? "Funding account has insufficient balance" : finalStatus === "FAILED" ? "Transaction failed" : "Payment instruction scheduled for execution",
    scheduledAt: new Date().toISOString(), remarks: a.remarks,
    _links: [{ rel: "status", href: `/payouts/v3/payments?paymentReferenceId=${paymentReferenceId}` }],
  };
  // What get_payouts will show afterwards (the bank completes successful payouts immediately in the mock).
  const stored = {
    clientReferenceId: a.clientReferenceId, paymentReferenceId,
    ...(finalStatus === "SUCCESS" ? { bankTransactionReferenceId: String(Math.floor(1e11 + Math.random() * 9e11)) } : {}),
    mode: a.mode, amount: a.amount, ...(masked ? { accountNumber: masked } : {}), ...(a.vpa ? { vpa: a.vpa } : {}),
    payeeName: a.payeeName, fees: { currency: "INR", value: 0 }, tax: { currency: "INR", value: 0 }, remarks: a.remarks,
    status: finalStatus,
    message: finalStatus === "SUCCESS" ? "Payment instruction successfully executed with bank" : created.message,
    createdAt: created.scheduledAt, updatedAt: new Date().toISOString(), scheduledAt: created.scheduledAt,
  };
  await sql`
    INSERT INTO mock_pl_payouts (payment_reference_id, client_reference_id, status, amount_paise, body)
    VALUES (${paymentReferenceId}, ${a.clientReferenceId}, ${finalStatus}, ${a.amount.value}, ${JSON.stringify(stored)}::jsonb)`;
  return { status: 201, body: created };
}
