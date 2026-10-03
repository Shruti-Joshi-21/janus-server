// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/pinelabs.test.mjs [base-url]
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 600)); }
};
async function rpc(path, method, params) {
  const res = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
async function pl(name, args) {
  const r = await rpc("/pinelabs/mcp", "tools/call", { name, arguments: args });
  const text = r.content[0].text;
  const status = text.match(/^HTTP (\d+): /)?.[1];
  let json = null;
  try { json = JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch {}
  return { status: status ? Number(status) : 200, json, isError: !!r.isError, text };
}
const core = async (name, args) => (await rpc("/janus-core/mcp", "tools/call", { name, arguments: args })).structuredContent;
const PRIYA = "cust-v1-250901101500-aa-PRIYA1";
const run = Date.now().toString(36);

const list = await rpc("/pinelabs/mcp", "tools/list", {});
check("13 Pine Labs tools", list.tools.length === 13, list.tools.map((t) => t.name));

// ── One-Time Mandate: ₹2,500 block for Ramesh's AC repair, debit ₹2,200 after the job
let r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-${run}`, customer_id: PRIYA, plan_details: { amount: 250000, currency: "INR", validity_days: 30, description: "AC repair, Ramesh" } });
const sub = r.json;
check("OTM create -> 201 CREATED, DIRECT_EXECUTION, ids", r.status === 200 && sub?.status === "CREATED" && sub.execution_mode === "DIRECT_EXECUTION" && /^v1-sub-/.test(sub.subscription_id) && /^v1-\d{12}-aa-/.test(sub.order_id), r);
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-${run}`, customer_id: PRIYA, plan_details: { amount: 250000, validity_days: 30 } });
check("same reference again -> 422 DUPLICATE_REQUEST", r.status === 422 && r.json?.code === "DUPLICATE_REQUEST", r.text);
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-big-${run}`, customer_id: PRIYA, plan_details: { amount: 15000000, validity_days: 30 } });
check("₹1.5 lakh -> 400 amount_exceeds_limit", r.status === 400 && r.json?.additional_error_details?.reason === "amount_exceeds_limit", r.text);
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-long-${run}`, customer_id: PRIYA, plan_details: { amount: 100000, validity_days: 90 } });
check("90 days -> 400 invalid_validity", r.status === 400 && r.json?.additional_error_details?.reason === "invalid_validity", r.text);
r = await pl("create_presentation", { subscription_id: sub.subscription_id, amount: { value: 220000, currency: "INR" }, merchant_presentation_reference: `pres-early-${run}` });
check("debit before customer approves -> 400 subscription_not_active", r.status === 400 && r.json?.additional_error_details?.reason === "subscription_not_active", r.text);
const mandatePay = (order_id, value, ref) => pl("create_mandate_payment", { order_id, payments: [{ merchant_payment_reference: ref, payment_method: "UPI", payment_amount: { value, currency: "INR" }, payment_option: { upi_details: { txn_mode: "INTENT" } }, mandate_info: { request_type: "CREATE_MANDATE" } }] });
r = await mandatePay(sub.order_id, 200000, `pay-x-${run}`);
check("mandate payment amount ≠ mandate -> 400 amount_mismatch", r.status === 400 && r.json?.additional_error_details?.reason === "amount_mismatch", r.text);
r = await mandatePay(sub.order_id, 250000, `pay-${run}`);
check("mandate approved -> AUTHORIZED", r.json?.data?.status === "AUTHORIZED" && r.json.data.payments[0].status === "AUTHORIZED", r.json);
r = await pl("get_ot_subscription", { subscription_id: sub.subscription_id });
check("get_ot_subscription -> ACTIVE (state persisted)", r.json?.status === "ACTIVE", r.json);
r = await pl("create_presentation", { subscription_id: sub.subscription_id, amount: { value: 300000, currency: "INR" }, merchant_presentation_reference: `pres-big-${run}` });
check("debit ₹3,000 on ₹2,500 mandate -> 400 amount_exceeds_mandate", r.status === 400 && r.json?.additional_error_details?.reason === "amount_exceeds_mandate", r.text);
r = await pl("create_presentation", { subscription_id: sub.subscription_id, amount: { value: 220000, currency: "INR" }, merchant_presentation_reference: `pres-${run}` });
const pres = r.json;
check("debit ₹2,200 -> 201 CREATED presentation", r.status === 200 && pres?.status === "CREATED" && /^v1-bil-/.test(pres.presentation_id), r);
r = await pl("create_presentation", { subscription_id: sub.subscription_id, amount: { value: 220000, currency: "INR" }, merchant_presentation_reference: `pres-${run}` });
check("same presentation reference -> 409 DUPLICATE_REQUEST (never debits twice)", r.status === 409 && r.json?.code === "DUPLICATE_REQUEST", r.text);
r = await pl("get_presentation", { presentation_id: pres.presentation_id });
check("get_presentation -> COMPLETED, pdn NOTIFIED", r.json?.status === "COMPLETED" && r.json.pdn_status === "NOTIFIED" && r.json.amount.value === 220000, r.json);
r = await pl("get_ot_subscription", { subscription_id: sub.subscription_id });
check("OTM closes after one debit -> COMPLETED", r.json?.status === "COMPLETED", r.json);
r = await pl("create_presentation", { subscription_id: sub.subscription_id, amount: { value: 10000, currency: "INR" }, merchant_presentation_reference: `pres-2-${run}` });
check("second debit on OTM -> refused", r.status === 400, r.text);

// Revoke a mandate
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-rev-${run}`, customer_id: PRIYA, plan_details: { amount: 50000, validity_days: 7 } });
const sub2 = r.json;
r = await pl("cancel_subscription", { subscription_id: sub2.subscription_id });
check("revoke mandate -> CANCELLED", r.json?.status === "CANCELLED", r.json);
r = await mandatePay(sub2.order_id, 50000, `pay-rev-${run}`);
check("approve a revoked mandate -> refused", r.status === 400, r.text);

// ── UPI AutoPay: quarterly RO AMC
r = await pl("create_subscription", { merchant_subscription_reference: `amc-${run}`, plan_id: "v1-pla-250901101600-aa-ROAMC1", customer_id: PRIYA, start_date: "2026-10-05T00:00:00Z", end_date: "2027-10-04T00:00:00Z", integration_mode: "SEAMLESS" });
const amc = r.json;
check("AutoPay subscription created with plan_details", amc?.status === "CREATED" && amc.plan_details.frequency === "Quarterly" && amc.order_amount.value === 50000, r);
r = await mandatePay(amc.order_id, 50000, `pay-amc-${run}`);
r = await pl("get_subscription", { subscription_id: amc.subscription_id });
check("AutoPay mandate approved -> ACTIVE", r.json?.status === "ACTIVE", r.json);
r = await pl("create_presentation", { subscription_id: amc.subscription_id, amount: { value: 50000, currency: "INR" }, merchant_presentation_reference: `amc-q1-${run}` });
r = await pl("create_presentation", { subscription_id: amc.subscription_id, amount: { value: 50000, currency: "INR" }, merchant_presentation_reference: `amc-q2-${run}` });
check("recurring subscription can be debited again", r.json?.status === "CREATED", r.text);
r = await pl("create_subscription", { merchant_subscription_reference: `amc-bad-${run}`, plan_id: "v1-pla-nope", customer_id: PRIYA, start_date: "2026-10-05T00:00:00Z", end_date: "2027-10-04T00:00:00Z", integration_mode: "SEAMLESS" });
check("unknown plan -> 404", r.status === 404, r.text);

// ── Payouts: balance ₹2,000
r = await pl("get_payout_balance", {});
check("balance ₹2,000 = 200000 paise", r.json?.balance?.value === 200000, r.json);
r = await pl("create_payout", { clientReferenceId: `pout-big-${run}`, payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: { value: 250000, currency: "INR" }, mode: "UPI", remarks: "AC repair job" });
check("₹2,500 payout vs ₹2,000 balance -> PENDING, insufficient balance", r.status === 200 && r.json?.status === "PENDING" && r.json.message === "Funding account has insufficient balance", r.json);
r = await pl("get_payout_balance", {});
check("...and no money moved", r.json?.balance?.value === 200000, r.json);
r = await pl("create_payout", { clientReferenceId: `pout-${run}`, payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: { value: 120000, currency: "INR" }, mode: "UPI", remarks: "AC repair labour" });
const pout = r.json;
check("₹1,200 UPI payout -> SCHEDULED", pout?.status === "SCHEDULED" && /^txn-[0-9a-f]{32}$/.test(pout.paymentReferenceId), r);
r = await pl("create_payout", { clientReferenceId: `pout-${run}`, payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: { value: 120000, currency: "INR" }, mode: "UPI", remarks: "AC repair labour" });
check("same clientReferenceId -> 409 DUPLICATE_REQUEST", r.status === 409 && r.json?.code === "DUPLICATE_REQUEST", r.text);
r = await pl("get_payout_balance", {});
check("balance now ₹800 (paid once, not twice)", r.json?.balance?.value === 80000, r.json);
r = await pl("get_payouts", { paymentReferenceId: pout.paymentReferenceId });
check("get_payouts -> SUCCESS with UTR", r.json?.payments?.[0]?.status === "SUCCESS" && /^\d{12}$/.test(r.json.payments[0].bankTransactionReferenceId) && r.json.totalRecords === 1, r.json);
r = await pl("get_payouts", { clientReferenceId: `pout-big-${run}` });
check("pending payout still PENDING", r.json?.payments?.[0]?.status === "PENDING", r.json);
r = await pl("create_payout", { clientReferenceId: `pout-imps-${run}`, payeeName: "Ramesh Patil", accountNumber: "500012121313141415", branchCode: "SBI0011123", amount: { value: 1000, currency: "INR" }, mode: "IMPS", remarks: "test" });
check("bad IFSC -> 400 invalid_branch_code", r.status === 400 && r.json?.additional_error_details?.reason === "invalid_branch_code", r.text);
r = await pl("create_payout", { clientReferenceId: `pout-name-${run}`, payeeName: "Ramesh P.", vpa: "x@y", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "test" });
check("payeeName with '.' -> 400 invalid_payee_name", r.status === 400 && r.json?.additional_error_details?.reason === "invalid_payee_name", r.text);
r = await pl("create_payout", { clientReferenceId: `pout-novpa-${run}`, payeeName: "Ramesh Patil", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "test" });
check("UPI without vpa -> 400", r.status === 400, r.text);

// ── Failure switches
await core("scenario_set", { key: "pinelabs.next_payout", value: "insufficient_balance" });
r = await pl("create_payout", { clientReferenceId: `pout-sw1-${run}`, payeeName: "Suresh More", vpa: "suresh.ro@ybl", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "AMC visit" });
check("switch insufficient_balance -> PENDING even for ₹10", r.json?.status === "PENDING", r.json);
await core("scenario_set", { key: "pinelabs.next_payout", value: "failed" });
r = await pl("create_payout", { clientReferenceId: `pout-sw2-${run}`, payeeName: "Suresh More", vpa: "suresh.ro@ybl", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "AMC visit" });
check("switch failed -> FAILED", r.json?.status === "FAILED", r.json);
r = await pl("get_payout_balance", {});
check("switched payouts moved no money", r.json?.balance?.value === 80000, r.json);
await core("scenario_set", { key: "pinelabs.next_payout", value: "timeout" });
let t0 = Date.now();
r = await pl("create_payout", { clientReferenceId: `pout-sw3-${run}`, payeeName: "Suresh More", vpa: "suresh.ro@ybl", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "AMC visit" });
check(`switch timeout -> HTTP 504 after ${Date.now() - t0} ms`, r.status === 504 && Date.now() - t0 < 10000, r.text);
await core("scenario_set", { key: "pinelabs.next_mandate", value: "declined" });
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-dec-${run}`, customer_id: PRIYA, plan_details: { amount: 100000, validity_days: 10 } });
const sub3 = r.json;
check("declined switch not used by create (it waits for approval step)", sub3?.status === "CREATED", r.text);
r = await mandatePay(sub3.order_id, 100000, `pay-dec-${run}`);
check("switch declined -> payment FAILED with PAYMENT_DECLINED", r.json?.data?.payments?.[0]?.status === "FAILED" && r.json.data.payments[0].error_detail.code === "PAYMENT_DECLINED", r.json);
r = await pl("get_ot_subscription", { subscription_id: sub3.subscription_id });
check("declined mandate stays CREATED (not ACTIVE)", r.json?.status === "CREATED", r.json);
await core("scenario_set", { key: "pinelabs.next_mandate", value: "malformed" });
r = await pl("create_ot_subscription", { merchant_subscription_reference: `otm-mal-${run}`, customer_id: PRIYA, plan_details: { amount: 100000, validity_days: 10 } });
check("switch malformed -> unparseable reply", r.json === null && !r.isError, r.text);

console.log(`\n${passed} passed, ${failed} failed`);
