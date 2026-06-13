const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let Stripe = null;
try {
  Stripe = require("stripe");
} catch {
  Stripe = null;
}

const root = __dirname;

function loadEnvFile() {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 4175);
const host = process.env.HOST || "0.0.0.0";
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : root;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const bookingsFile = path.join(dataDir, "bookings.jsonl");
const settingsFile = path.join(dataDir, "site-settings.json");
const ownerEmail = process.env.BOOKING_OWNER_EMAIL || "lvlc.support@lovelylocsnc.com";
const ownerPhone = process.env.BOOKING_OWNER_PHONE || "3364711098";
const emailLogoUrl = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6978dfbb416a772de9813cbb/da2605355_ModernBeigeBuyOneCoffeeGetOneFreeHalfPageAd.png";
const dayMs = 24 * 60 * 60 * 1000;
const referralCreditAmount = Number(process.env.REFERRAL_CREDIT_AMOUNT || 15);
const referredNewClientCreditAmount = Number(process.env.REFERRED_NEW_CLIENT_CREDIT_AMOUNT || 15);
const birthdayCreditAmount = Number(process.env.BIRTHDAY_CREDIT_AMOUNT || 15);
let stripeClient = null;
let googleJwksCache = { expiresAt: 0, keys: [] };

const defaultSiteSettings = {
  logo: {
    navSize: 40,
    heroSize: 88,
    heroAlign: "left",
    fit: "cover",
    x: 50,
    y: 50,
  },
  discount: {
    code: "LOVELY10",
    percent: 10,
    enabled: false,
    expiresAt: "",
  },
};

const serviceCatalog = [
  { id: "sprinkles-addon", duration: "30 min", price: 15, name: "Loc Sprinkles (Add On)", category: "add-ons" },
  { id: "emergency-fee", duration: "3h", price: 45, name: "Emergency Fee", category: "add-ons" },
  { id: "children-instant-starter", duration: "5h", price: 150, name: "Children Instant Starter Locs", category: "starter-locs" },
  { id: "medium-adult-starter", duration: "6h 30min", price: 150, name: "Medium Adult Starter Locs", category: "starter-locs" },
  { id: "adult-retwist", duration: "3h 30min", price: 90, name: "Adult Retwist (Maintenance)", category: "loc-maintenance" },
  { id: "child-starter-coils", duration: "3h 30min", price: 75, name: "Children's Starter Locs Coils & Two Strand Twist", category: "starter-locs" },
  { id: "sprinkle-install", duration: "2h 15min", price: 50, name: "Loc Sprinkle Installation", category: "add-ons" },
  { id: "children-retwist", duration: "3h", price: 75, name: "Children Retwist (Maintenance)", category: "loc-maintenance" },
  { id: "adult-instant", duration: "5h 30min", price: 125, name: "Adult Instant Locs", category: "instant-crochet" },
  { id: "child-instant", duration: "3h 30min", price: 85, name: "Children's Instant Loc", category: "instant-crochet" },
  { id: "referral-retwist", duration: "3h 30min", price: 75, name: "Referral (Retwist)", category: "loc-maintenance" },
  { id: "style-addon", duration: "1h 30min", price: 30, name: "Style (Add On)", category: "add-ons" },
  { id: "consultation", duration: "1h 15min", price: 30, name: "Consultation", category: "add-ons" },
  { id: "small-adult-starter", duration: "5h 30min", price: 225, name: "Small Adult Starter Locs", category: "starter-locs" },
  { id: "overdue-retwist", duration: "4-5 hours", price: 125, name: "Overdue Retwist (4+ Months)", category: "loc-maintenance" },
  { id: "admin-test-booking", duration: "15 min", price: 0, name: "Free Admin Test Booking", category: "admin-test" },
];

const productCatalog = [
  { id: "product-Gold Sparkle Sprinkles", price: 12, name: "Gold Sparkle Sprinkles" },
  { id: "product-Silver Shimmer Sprinkles", price: 12, name: "Silver Shimmer Sprinkles" },
  { id: "product-Rose Gold Sprinkles", price: 12, name: "Rose Gold Sprinkles" },
  { id: "product-Custom Color Sprinkles", price: 15, name: "Custom Color Sprinkles" },
];

const allowedBaseProducts = new Set(["Oil and Water", "Foam", "Gel"]);
const allowedLocJourneyLengths = new Set(["", "exploring", "under_1_year", "1_to_3_years", "3_to_5_years", "5_plus_years"]);
const allowedPartingFees = new Map([
  ["Brick Layered Parts", 0],
  ["Natural C Parts", 0],
  ["Triangle Parts", 40],
]);

const regularAppointmentTimes = ["18:30", "19:30", "20:30"];
const friendTestCheckpoints = ["home", "services", "products", "policies", "contact", "privacy", "sms-opt-in", "terms"];
const friendTestCampaign = "friends-booking-test-2026-06";
const friendTestCampaignLimit = 10;
const emergencyProposalTimes = ["10:00", "12:00", "14:00", "16:00", "22:30"];
const holidayDates = new Set([
  "2026-01-01",
  "2026-05-25",
  "2026-07-04",
  "2026-09-07",
  "2026-11-26",
  "2026-12-24",
  "2026-12-25",
  "2026-12-31",
]);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function bookingText(booking) {
  const discountLabel = booking.discountPercent
    ? `${booking.discountPercent}% off`
    : `$${booking.discountAmount || 0} off`;
  const serviceLines = (booking.cart || []).map(item => {
    const details = [
      item.duration ? `Time: ${item.duration}` : "",
      item.baseProduct ? `Base product: ${item.baseProduct}` : "",
      item.partingPreference ? `Parting: ${item.partingPreference}${item.partingFee ? ` (+$${item.partingFee})` : ""}` : "",
    ].filter(Boolean).join("; ");
    return `- ${item.name} ($${item.price}${details ? ` | ${details}` : ""})`;
  });

  return [
    "Lovely Locs appointment request",
    "",
    `Client: ${booking.client?.fullName || ""}`,
    `Email: ${booking.client?.email || ""}`,
    `Phone: ${booking.client?.phone || ""}`,
    `Appointment date: ${booking.client?.date || ""}`,
    `Appointment time: ${timeLabel(booking.client?.time)}`,
    booking.client?.birthday ? `Birthday: ${booking.client.birthday}` : "",
    `Appointment type: ${booking.client?.appointmentType || "standard"}`,
    `Preferred contact: ${contactPreferenceLabel(booking.client?.preferredContact)}`,
    `Optional communications opt-in: ${booking.client?.smsOptIn ? "Yes" : "No"}`,
    booking.client?.referralCode ? `Client referral code: ${booking.client.referralCode}` : "",
    booking.client?.referredByCode ? `Referred by code: ${booking.client.referredByCode}` : "",
    booking.friendTest ? `Friend website test: ${booking.friendTest.code}` : "",
    booking.friendTest ? `Website coverage: ${booking.friendTest.completedCheckpoints}/${booking.friendTest.totalCheckpoints} checkpoints (${booking.friendTest.percentComplete}%)` : "",
    booking.friendTest ? `Missing checkpoints: ${booking.friendTest.missing.join(", ") || "None - Golden Loc unlocked"}` : "",
    "",
    "Services / products:",
    serviceLines.length ? serviceLines.join("\n") : "- No cart items included",
    "",
    booking.subtotal && booking.discountAmount ? `Subtotal before promo: $${booking.subtotal}` : "",
    booking.discountAmount ? `Promo code: ${booking.discountCode || ""} (${discountLabel}, -$${booking.discountAmount})` : "",
    `Estimated total: $${booking.total || 0}`,
    `Deposit required: $${booking.deposit || 0}`,
    "",
    `Notes: ${booking.client?.specialRequests || "No special requests added."}`,
    "",
    "Policy acknowledgement: Client confirmed they read the Lovely Locs policies.",
    "Studio note: Address is shared after booking and deposit are confirmed.",
  ].join("\n");
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailDetailRows(rows = []) {
  return rows
    .filter(row => row?.value !== undefined && row?.value !== null && String(row.value).trim() !== "")
    .map(row => `
      <tr>
        <td style="padding:10px 0;color:#7a6257;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(row.label)}</td>
        <td style="padding:10px 0;color:#3b2821;font-size:15px;text-align:right;font-weight:700;">${escapeHtml(row.value)}</td>
      </tr>
    `).join("");
}

function serviceSummaryHtml(booking) {
  const items = (booking.selectedServices?.length ? booking.selectedServices : booking.cart || []);
  if (!items.length) return "";
  return items.map(item => {
    const details = [
      item.duration ? `Time: ${item.duration}` : "",
      item.baseProduct ? `Base product: ${item.baseProduct}` : "",
      item.partingPreference ? `Parting: ${item.partingPreference}${item.partingFee ? ` (+$${item.partingFee})` : ""}` : "",
    ].filter(Boolean).join(" • ");
    return `<li style="margin:0 0 8px;color:#3b2821;"><strong>${escapeHtml(item.name)}</strong>${details ? `<br><span style="color:#7a6257;">${escapeHtml(details)}</span>` : ""}</li>`;
  }).join("");
}

function referralEmailCardHtml(referral = {}) {
  referral = referral || {};
  if (!referral.code || !referral.shareUrl) return "";
  return `
    <div style="margin-top:22px;background:linear-gradient(135deg,#f3e6f5,#fff1ea);border:1px solid #ddc2df;border-radius:16px;padding:20px;text-align:center;">
      <p style="margin:0 0 7px;color:#7b4f5f;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;">Good People Know Good People</p>
      <h2 style="margin:0 0 9px;color:#3b2821;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;">Share Lovely Locs</h2>
      <p style="margin:0 0 12px;color:#6c544b;font-size:14px;line-height:1.5;">Send your personal code or link to someone who would love a Lovely Locs appointment.</p>
      <div style="margin:0 auto 14px;background:#3b2821;color:#fffaf7;border-radius:12px;padding:13px 14px;font-size:18px;font-weight:800;letter-spacing:.04em;">${escapeHtml(referral.code)}</div>
      <a href="${escapeHtml(referral.shareUrl)}" style="background:#7b4f5f;color:#ffffff;text-decoration:none;border-radius:999px;display:inline-block;padding:13px 18px;font-weight:800;">Share My Referral Link</a>
    </div>`;
}

function brandEmailHtml({ eyebrow = "Lovely Locs", title, intro, rows = [], services = "", referral = null, note = "", ctaUrl = "", ctaLabel = "" }) {
  return `
  <div style="margin:0;padding:0;background:#f8f0ea;font-family:Arial,Helvetica,sans-serif;color:#3b2821;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f0ea;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fffaf7;border:1px solid #ead8cf;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="background:#3b2821;padding:24px;text-align:center;">
                <img src="${emailLogoUrl}" alt="Lovely Locs" width="92" height="92" style="display:block;margin:0 auto 12px;border-radius:999px;object-fit:cover;border:3px solid #f3d9ce;">
                <p style="margin:0;color:#f3d9ce;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;">${escapeHtml(eyebrow)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 28px 12px;">
                <h1 style="margin:0 0 12px;color:#3b2821;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.15;font-weight:400;">${escapeHtml(title)}</h1>
                <p style="margin:0;color:#6c544b;font-size:16px;line-height:1.65;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 28px 24px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #ead8cf;border-bottom:1px solid #ead8cf;">
                  ${emailDetailRows(rows)}
                </table>
                ${services ? `<div style="margin-top:22px;"><p style="margin:0 0 10px;color:#7a6257;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Service Details</p><ul style="padding-left:20px;margin:0;">${services}</ul></div>` : ""}
                ${referralEmailCardHtml(referral)}
                ${note ? `<div style="margin-top:22px;background:#f1e3dc;border-radius:14px;padding:16px;color:#5d453c;font-size:15px;line-height:1.55;">${escapeHtml(note)}</div>` : ""}
                ${ctaUrl && ctaLabel ? `<p style="margin:26px 0 0;"><a href="${escapeHtml(ctaUrl)}" style="background:#7b4f5f;color:#ffffff;text-decoration:none;border-radius:999px;display:inline-block;padding:13px 18px;font-weight:800;">${escapeHtml(ctaLabel)}</a></p>` : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;background:#fff3ee;color:#7a6257;font-size:13px;line-height:1.5;text-align:center;">
                Lovely Locs • Private in-home studio • Address shared after confirmation
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>`;
}

function confirmationEmail(booking, { test = false } = {}) {
  const title = test ? "Your Lovely Locs test booking came through" : "Your loc time is confirmed";
  const intro = test
    ? "This was a no-charge owner test, but the email style matches what clients will see after a confirmed deposit."
    : "Take a breath, your appointment request is no longer floating around. Your deposit has been received, and your Lovely Locs time is saved.";
  const rows = [
    { label: "Client", value: booking.client?.fullName },
    { label: "Date", value: booking.client?.date },
    { label: "Time", value: timeLabel(booking.client?.time) },
    { label: "Booking ID", value: booking.id },
    { label: "Deposit", value: `$${booking.deposit || 0}` },
    { label: "Estimated Total", value: `$${booking.total || 0}` },
  ];
  const referralCode = normalizeReferralCode(booking.client?.referralCode || referralCodeForClient(booking.client));
  const siteUrl = String(process.env.PUBLIC_SITE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const referralShareUrl = booking.referralShareUrl || `${siteUrl}/?ref=${encodeURIComponent(referralCode)}#services`;
  return {
    text: [
      title,
      "",
      intro,
      "",
      `Booking ID: ${booking.id}`,
      `Date: ${booking.client?.date || ""}`,
      `Time: ${timeLabel(booking.client?.time)}`,
      `Deposit: $${booking.deposit || 0}`,
      "",
      "Your personal referral code:",
      referralCode,
      `Share link: ${referralShareUrl}`,
      "",
      "Please arrive with your hair ready for the service unless Lovely Locs has told you otherwise. The private studio address is shared after confirmation.",
      "",
      bookingText(booking),
    ].join("\n"),
    html: brandEmailHtml({
      eyebrow: test ? "Owner Test" : "Appointment Confirmed",
      title,
      intro,
      rows,
      services: serviceSummaryHtml(booking),
      referral: { code: referralCode, shareUrl: referralShareUrl },
      note: "Please arrive with your hair ready for the service unless Lovely Locs has told you otherwise. The private studio address is shared after confirmation.",
    }),
  };
}

function ownerBookingEmail(booking, { title, intro, ctaUrl = "", ctaLabel = "" }) {
  const rows = [
    { label: "Client", value: booking.client?.fullName },
    { label: "Client Email", value: booking.client?.email },
    { label: "Phone", value: booking.client?.phone },
    { label: "Date", value: booking.client?.date },
    { label: "Time", value: timeLabel(booking.client?.time) },
    { label: "Booking ID", value: booking.id },
    { label: "Deposit", value: `$${booking.deposit || 0}` },
    { label: "Estimated Total", value: `$${booking.total || 0}` },
    booking.friendTest ? { label: "Friend Test", value: booking.friendTest.code } : null,
    booking.friendTest ? { label: "Website Coverage", value: `${booking.friendTest.completedCheckpoints}/${booking.friendTest.totalCheckpoints} checkpoints (${booking.friendTest.percentComplete}%)` } : null,
  ].filter(Boolean);
  const friendTestNote = booking.friendTest
    ? `Friend test ${booking.friendTest.complete ? "complete" : "incomplete"}. Missing: ${booking.friendTest.missing.join(", ") || "none"}.`
    : "";
  return brandEmailHtml({
    eyebrow: "Owner Update",
    title,
    intro,
    rows,
    services: serviceSummaryHtml(booking),
    note: [
      booking.client?.specialRequests ? `Client notes: ${booking.client.specialRequests}` : "No special client notes were added.",
      friendTestNote,
    ].filter(Boolean).join(" "),
    ctaUrl,
    ctaLabel,
  });
}

function gmailComposeUrl(to, subject, body) {
  const url = new URL("https://mail.google.com/mail/");
  url.searchParams.set("view", "cm");
  url.searchParams.set("fs", "1");
  url.searchParams.set("to", to || "");
  url.searchParams.set("su", subject || "");
  url.searchParams.set("body", body || "");
  return url.toString();
}

function timeLabel(value) {
  const [hourText, minuteText] = String(value || "").split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function contactPreferenceLabel(value) {
  if (value === "text") return "Text";
  if (value === "email") return "Email";
  return "Text + Email";
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${text}`.trim());
  }
  return response.json().catch(() => ({}));
}

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.CONFIRMATION_FROM_EMAIL);
}

function configuredEmailAddress(value = "") {
  const match = String(value).match(/<([^>]+)>/);
  return (match ? match[1] : String(value)).trim().toLowerCase();
}

function emailReadiness() {
  if (!emailConfigured()) {
    return {
      configured: false,
      clientReady: false,
      reason: "RESEND_API_KEY and CONFIRMATION_FROM_EMAIL are required before any email can send.",
    };
  }
  const from = configuredEmailAddress(process.env.CONFIRMATION_FROM_EMAIL);
  const domain = from.includes("@") ? from.split("@").pop() : "";
  if (!domain || domain === "yourdomain.com") {
    return {
      configured: true,
      clientReady: false,
      from,
      reason: "CONFIRMATION_FROM_EMAIL is still a placeholder. Use a verified domain sender such as bookings@yourdomain.com.",
    };
  }
  if (["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com"].includes(domain)) {
    return {
      configured: true,
      clientReady: false,
      from,
      reason: "Use a verified custom domain sender in Resend instead of a public mailbox domain.",
    };
  }
  return {
    configured: true,
    clientReady: true,
    from,
    reason: `${from} is configured as the client confirmation sender.`,
  };
}

async function sendEmail(to, subject, text, html = "") {
  if (!emailConfigured()) {
    return { provider: "resend", skipped: true, reason: "RESEND_API_KEY and CONFIRMATION_FROM_EMAIL are not set" };
  }

  await postJson("https://api.resend.com/emails", {
    from: process.env.CONFIRMATION_FROM_EMAIL,
    to,
    subject,
    text,
    html: html || undefined,
  }, {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
  });
  return { provider: "resend", skipped: false };
}

function smsBlockedReason() {
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) return `${missing.join(", ")} are not set`;
  if (process.env.TWILIO_TOLLFREE_VERIFIED === "false") {
    return "Twilio toll-free verification is still pending. Keep SMS transactional only until approval is complete.";
  }
  return "";
}

async function sendSms(to, body) {
  const blockedReason = smsBlockedReason();
  if (blockedReason) {
    return { provider: "twilio", skipped: true, reason: blockedReason };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  const params = new URLSearchParams({
    From: TWILIO_FROM_NUMBER,
    To: to,
    Body: body,
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${text}`.trim());
  }
  return { provider: "twilio", skipped: false };
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}

function phoneDigits(phone = "") {
  return String(phone).replace(/[^0-9]/g, "");
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe Checkout is not configured. Add STRIPE_SECRET_KEY in Render.");
  }
  if (!Stripe) {
    throw new Error("Stripe package is not installed. Run npm install before starting the server.");
  }
  if (!stripeClient) stripeClient = Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function publicSiteUrl(req) {
  const configured = (process.env.PUBLIC_SITE_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${port}`;
  return `${proto}://${hostHeader}`.replace(/\/+$/, "");
}

function appendBookingRecord(record) {
  fs.appendFileSync(bookingsFile, `${JSON.stringify(record)}\n`, "utf8");
}

function readBookingRecords() {
  if (!fs.existsSync(bookingsFile)) return [];
  return fs.readFileSync(bookingsFile, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function findBookingById(id, records = readBookingRecords()) {
  if (!id) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.id === id && record.client && Array.isArray(record.cart)) return record;
  }
  return null;
}

function latestClientBooking(client, records = readBookingRecords()) {
  const email = String(client.email || "").trim().toLowerCase();
  const phone = phoneDigits(client.phone);
  if (!email || phone.length < 10) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record?.client || !Array.isArray(record.cart)) continue;
    if (String(record.client.email || "").trim().toLowerCase() === email && phoneDigits(record.client.phone) === phone) {
      return record;
    }
  }
  return null;
}

function latestClientBookingByEmail(email, records = readBookingRecords()) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record?.client || !Array.isArray(record.cart)) continue;
    if (String(record.client.email || "").trim().toLowerCase() === normalized) {
      return record;
    }
  }
  return null;
}

function latestClientProfile(client, records = readBookingRecords()) {
  const key = clientIdentityKey(client);
  if (!key) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "client.profile.saved") continue;
    if (record.clientKey === key) return record;
  }
  return null;
}

function latestClientProfileByEmail(email, records = readBookingRecords()) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "client.profile.saved") continue;
    if (String(record.client?.email || "").trim().toLowerCase() === normalized) return record;
  }
  return null;
}

function latestClientProfileByGoogleSubject(subject, records = readBookingRecords()) {
  const normalized = String(subject || "").trim();
  if (!normalized) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "client.profile.saved") continue;
    if (String(record.googleSubject || "").trim() === normalized) return record;
  }
  return null;
}

function isAdminTestBooking(cart = []) {
  return cart.length === 1 && cart[0]?.id === "admin-test-booking";
}

function normalizeReferralCode(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9/_-]/g, "");
}

function normalizeDiscountCode(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9_-]/g, "");
}

function clientIdentityKey(client = {}) {
  const email = String(client.email || "").trim().toLowerCase();
  const phone = phoneDigits(client.phone);
  if (!email || phone.length < 10) return "";
  return `${email}|${phone}`;
}

function sameClient(a = {}, b = {}) {
  return clientIdentityKey(a) && clientIdentityKey(a) === clientIdentityKey(b);
}

function referralCodeForClient(client = {}) {
  const existing = normalizeReferralCode(client.referralCode);
  if (existing) return existing;
  const username = String(client.fullName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 18);
  return normalizeReferralCode(`LOVELYLOCS/${username || phoneDigits(client.phone).slice(-6) || "GUEST"}`);
}

function findReferrerByCode(code, records = readBookingRecords()) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const storedCode = normalizeReferralCode(record?.client?.referralCode);
    const currentCode = normalizeReferralCode(referralCodeForClient(record?.client || {}));
    if ((storedCode && storedCode === normalized) || (currentCode && currentCode === normalized)) {
      return record;
    }
  }
  return null;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function sanitizeDiscountSettings(discount = {}) {
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(discount.expiresAt || "") ? discount.expiresAt : "";
  return {
    code: normalizeDiscountCode(discount.code || defaultSiteSettings.discount.code) || defaultSiteSettings.discount.code,
    percent: clampNumber(discount.percent, 0, 100, defaultSiteSettings.discount.percent),
    enabled: Boolean(discount.enabled),
    expiresAt,
  };
}

function readSiteSettings() {
  if (!fs.existsSync(settingsFile)) {
    return {
      ...defaultSiteSettings,
      discount: { ...defaultSiteSettings.discount },
      logo: { ...defaultSiteSettings.logo },
    };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    return {
      logo: { ...defaultSiteSettings.logo, ...(saved.logo || {}) },
      discount: sanitizeDiscountSettings(saved.discount || {}),
    };
  } catch {
    return {
      ...defaultSiteSettings,
      discount: { ...defaultSiteSettings.discount },
      logo: { ...defaultSiteSettings.logo },
    };
  }
}

function saveSiteSettings(settings = {}) {
  const current = readSiteSettings();
  const next = {
    logo: { ...current.logo, ...(settings.logo || {}) },
    discount: sanitizeDiscountSettings(settings.discount || current.discount),
  };
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function discountIsExpired(discount) {
  if (!discount?.expiresAt) return false;
  const expiration = new Date(`${discount.expiresAt}T23:59:59`);
  return Number.isFinite(expiration.getTime()) && expiration.getTime() < Date.now();
}

function activeDiscountForCode(code) {
  const requestedCode = normalizeDiscountCode(code);
  if (!requestedCode) return null;
  const settings = readSiteSettings().discount;
  if (!settings.enabled) return null;
  if (discountIsExpired(settings)) return null;
  if (normalizeDiscountCode(settings.code) !== requestedCode) return null;
  return settings;
}

function discountAmountForTotal(total, discount) {
  if (discount?.amountOff) return Math.min(total, Math.max(0, Math.round(Number(discount.amountOff))));
  if (!discount?.percent) return 0;
  return Math.min(total, Math.max(0, Math.round(total * Number(discount.percent) / 100)));
}

function creditIsUnavailable(records, creditId) {
  if (!creditId) return true;
  return records.some(record => (
    ["discount.credit.reserved", "discount.credit.redeemed"].includes(record.type)
    && record.creditId === creditId
  ));
}

function creditIsExpired(record = {}) {
  if (!record.expiresAt) return false;
  const expiration = new Date(`${record.expiresAt}T23:59:59`);
  return Number.isFinite(expiration.getTime()) && expiration.getTime() < Date.now();
}

function availableClientCredit(client, total, records = readBookingRecords()) {
  const key = clientIdentityKey(client);
  if (!key) return null;
  const credits = records.filter(record => (
    ["referral.reward.approved", "birthday.reward.approved"].includes(record.type)
    && record.clientKey === key
    && !creditIsUnavailable(records, record.creditId)
    && !creditIsExpired(record)
  ));
  if (!credits.length) return null;
  const best = credits.reduce((currentBest, record) => (
    Number(record.amountOff || 0) > Number(currentBest.amountOff || 0) ? record : currentBest
  ), credits[0]);
  const amountOff = Math.min(total, Math.max(0, Math.round(Number(best.amountOff || 0))));
  if (!amountOff) return null;
  return {
    type: best.type === "birthday.reward.approved" ? "birthday" : "referral",
    creditId: best.creditId,
    code: best.discountCode || best.creditId,
    amountOff,
  };
}

function qualifiesForReferredNewClientDiscount(selectedServices = []) {
  return selectedServices.some(service => (
    service
    && service.type === "service"
    && service.category !== "add-ons"
    && service.category !== "admin-test"
    && !service.autoEmergencyFee
    && Number(service.price) > 75
  ));
}

function referredNewClientDiscount(client, total, selectedServices = [], records = readBookingRecords()) {
  const code = normalizeReferralCode(client?.referredByCode);
  if (!code) return null;
  const referrer = findReferrerByCode(code, records);
  if (!referrer || sameClient(referrer.client, client)) return null;
  if (latestClientBooking(client, records)) return null;
  if (!qualifiesForReferredNewClientDiscount(selectedServices)) return null;
  const amountOff = Math.min(total, Math.max(0, Math.round(referredNewClientCreditAmount)));
  if (!amountOff) return null;
  return {
    type: "referral_new_client",
    code: `NEW-${code}`,
    amountOff,
    source: "referral_new_client_rate",
  };
}

function chooseBookingDiscount(subtotal, saleDiscount, clientCredit, referredClientDiscount) {
  const saleAmount = discountAmountForTotal(subtotal, saleDiscount);
  const creditAmount = clientCredit ? discountAmountForTotal(subtotal, clientCredit) : 0;
  const referredClientAmount = referredClientDiscount ? discountAmountForTotal(subtotal, referredClientDiscount) : 0;
  if (clientCredit && creditAmount > saleAmount) {
    return {
      code: clientCredit.code,
      type: clientCredit.type,
      percent: 0,
      amountOff: creditAmount,
      creditId: clientCredit.creditId,
      source: "earned_client_credit",
    };
  }
  if (saleDiscount && saleAmount > 0) {
    return {
      code: saleDiscount.code,
      type: "sale",
      percent: saleDiscount.percent,
      amountOff: saleAmount,
      expiresAt: saleDiscount.expiresAt || "",
      source: "sale_code",
    };
  }
  if (referredClientDiscount && referredClientAmount > 0) {
    return {
      code: referredClientDiscount.code,
      type: referredClientDiscount.type,
      percent: 0,
      amountOff: referredClientAmount,
      source: referredClientDiscount.source,
    };
  }
  return null;
}

function reserveDiscountCredit(booking) {
  const credit = booking.automaticDiscountCredit;
  if (!credit?.creditId) return null;
  const event = {
    type: "discount.credit.reserved",
    bookingId: booking.id,
    clientKey: clientIdentityKey(booking.client),
    creditId: credit.creditId,
    creditType: credit.type,
    amountOff: credit.amountOff,
    reservedAt: new Date().toISOString(),
  };
  appendBookingRecord(event);
  return event;
}

function redeemDiscountCredit(booking, records = readBookingRecords()) {
  const credit = booking.automaticDiscountCredit;
  if (!credit?.creditId) return null;
  if (records.some(record => record.type === "discount.credit.redeemed" && record.creditId === credit.creditId)) return null;
  const event = {
    type: "discount.credit.redeemed",
    bookingId: booking.id,
    clientKey: clientIdentityKey(booking.client),
    creditId: credit.creditId,
    creditType: credit.type,
    amountOff: credit.amountOff,
    redeemedAt: new Date().toISOString(),
  };
  appendBookingRecord(event);
  return event;
}

function createPendingReferralReward(booking, records = readBookingRecords()) {
  const code = normalizeReferralCode(booking.client?.referredByCode);
  if (!code) return null;
  const referrer = findReferrerByCode(code, records);
  if (!referrer || sameClient(referrer.client, booking.client)) return null;
  if (records.some(record => record.type === "referral.reward.pending" && record.referredBookingId === booking.id)) return null;
  const event = {
    type: "referral.reward.pending",
    referralCode: code,
    referrerKey: clientIdentityKey(referrer.client),
    referrerBookingId: referrer.id,
    referredBookingId: booking.id,
    referredClientName: booking.client.fullName,
    amountOff: referralCreditAmount,
    createdAt: new Date().toISOString(),
  };
  appendBookingRecord(event);
  return event;
}

function approveReferralReward(booking, records = readBookingRecords()) {
  const code = normalizeReferralCode(booking.client?.referredByCode);
  if (!code) return null;
  const pending = records.find(record => record.type === "referral.reward.pending" && record.referredBookingId === booking.id);
  const referrer = pending ? null : findReferrerByCode(code, records);
  const referrerKey = pending?.referrerKey || clientIdentityKey(referrer?.client);
  if (!referrerKey || records.some(record => record.type === "referral.reward.approved" && record.referredBookingId === booking.id)) return null;
  const creditId = `referral:${booking.id}:${referrerKey}`;
  const event = {
    type: "referral.reward.approved",
    referralCode: code,
    clientKey: referrerKey,
    referredBookingId: booking.id,
    creditId,
    discountCode: `REF-${code}`,
    amountOff: referralCreditAmount,
    approvedAt: new Date().toISOString(),
  };
  appendBookingRecord(event);
  return event;
}

function birthdayRewardWindow(client, today = new Date()) {
  const birthday = String(client.birthday || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const [, monthText, dayText] = birthday.split("-");
  const month = Number(monthText);
  const day = Number(dayText);
  const year = today.getFullYear();
  const birthdayDate = new Date(Date.UTC(year, month - 1, day));
  const validFrom = new Date(birthdayDate.getTime() - 14 * dayMs);
  const expiresAt = new Date(birthdayDate.getTime() + 31 * dayMs);
  const cycleYear = String(year);
  return {
    birthdayDate: birthdayDate.toISOString().slice(0, 10),
    validFrom: validFrom.toISOString().slice(0, 10),
    expiresAt: expiresAt.toISOString().slice(0, 10),
    cycleYear,
    active: today >= validFrom && today <= expiresAt,
  };
}

function ensureBirthdayReward(booking, records = readBookingRecords(), today = new Date()) {
  const key = clientIdentityKey(booking.client);
  if (!key) return null;
  const window = birthdayRewardWindow(booking.client, today);
  if (!window?.active) return null;
  if (records.some(record => record.type === "birthday.reward.approved" && record.clientKey === key && record.cycleKey === window.cycleYear)) return null;
  const creditId = `birthday:${window.cycleYear}:${key}`;
  const code = `BDAY-${window.cycleYear}-${referralCodeForClient(booking.client)}`;
  const event = {
    type: "birthday.reward.approved",
    clientKey: key,
    bookingId: booking.id,
    creditId,
    discountCode: code,
    amountOff: birthdayCreditAmount,
    cycleKey: window.cycleYear,
    birthdayDate: window.birthdayDate,
    validFrom: window.validFrom,
    expiresAt: window.expiresAt,
    approvedAt: new Date().toISOString(),
  };
  appendBookingRecord(event);
  return event;
}

async function runNotificationTasks(tasks) {
  const results = [];
  for (const [channel, task] of tasks) {
    try {
      results.push({ channel, ...(await task()) });
    } catch (error) {
      results.push({ channel, failed: true, error: error.message });
    }
  }
  return results;
}

async function notifyDepositPaid(booking, session) {
  const paidAt = new Date().toISOString();
  const details = bookingText({
    ...booking,
    status: "deposit_paid",
    stripe: {
      checkoutSessionId: session.id,
      paymentIntentId: session.payment_intent || "",
      amountTotal: session.amount_total || 0,
      paidAt,
    },
  });
  const clientEmail = confirmationEmail(booking);
  const clientText = `Lovely Locs received your $${booking.deposit} deposit for ${booking.client.date}. Your appointment request is paid and pending final availability confirmation from Lovely Locs.`;
  const ownerText = `Stripe deposit paid for ${booking.client.fullName}: $${booking.deposit}. Preferred date: ${booking.client.date}. Total estimate: $${booking.total}.`;
  const results = await runNotificationTasks([
    ["clientEmail", () => sendEmail(booking.client.email, "Lovely Locs deposit received", clientEmail.text, clientEmail.html)],
    ["ownerEmail", () => sendEmail(ownerEmail, `Lovely Locs deposit paid: ${booking.client.fullName}`, `${ownerText}\n\n${details}`, ownerBookingEmail(booking, {
      title: `Deposit paid for ${booking.client.fullName}`,
      intro: "A client deposit has cleared. Use the booking details below to continue the confirmation process.",
    }))],
    ["ownerSms", () => sendSms(normalizePhone(ownerPhone), ownerText)],
  ]);
  return results;
}

async function notifyNoChargeTestBooking(booking) {
  const details = bookingText(booking);
  const clientEmail = confirmationEmail(booking, { test: true });
  const clientText = `Lovely Locs test booking received for ${booking.client.date}. This was a no-charge admin test, so no deposit was requested.`;
  const ownerText = `No-charge admin test booking submitted for ${booking.client.fullName}. Preferred date: ${booking.client.date}.`;
  return runNotificationTasks([
    ["clientEmail", () => sendEmail(booking.client.email, "Lovely Locs test booking received", clientEmail.text, clientEmail.html)],
    ["ownerEmail", () => sendEmail(ownerEmail, `Lovely Locs test booking: ${booking.client.fullName}`, `${ownerText}\n\n${details}`, ownerBookingEmail(booking, {
      title: `No-charge test booking: ${booking.client.fullName}`,
      intro: "This owner test skipped the payment step but exercised the same booking pipeline.",
    }))],
    ["ownerSms", () => sendSms(normalizePhone(ownerPhone), ownerText)],
  ]);
}

function normalizePhoneOrBlank(value = "") {
  const digits = phoneDigits(value);
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return String(value || "").trim();
}

function sanitizeClient(client = {}) {
  const normalizedAppointmentType = ["standard", "emergency"].includes(client.appointmentType) ? client.appointmentType : "standard";
  const birthday = String(client.birthday || "").trim();
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    throw new Error("Enter a valid birthday or leave it blank.");
  }
  return {
    fullName: String(client.fullName || "").trim(),
    email: String(client.email || "").trim().toLowerCase(),
    phone: normalizePhoneOrBlank(client.phone),
    date: String(client.date || "").trim(),
    time: String(client.time || "").trim(),
    birthday,
    locJourneyLength: allowedLocJourneyLengths.has(client.locJourneyLength) ? client.locJourneyLength : "",
    onboardingCompleted: Boolean(client.onboardingCompleted),
    appointmentType: normalizedAppointmentType,
    emergencySlot: Boolean(client.emergencySlot),
    emergencyReason: normalizedAppointmentType === "emergency" ? "Outside regular Lovely Locs evening hours." : "",
    preferredContact: ["text", "email", "text_email"].includes(client.preferredContact) ? client.preferredContact : "text_email",
    smsOptIn: Boolean(client.smsOptIn),
    marketingEmailOptIn: Boolean(client.marketingEmailOptIn),
    referralOptIn: Boolean(client.referralOptIn),
    referralCode: referralCodeForClient(client) || normalizeReferralCode(client.referralCode),
    referredByCode: normalizeReferralCode(client.referredByCode),
    googleSubject: String(client.googleSubject || "").trim(),
    specialRequests: String(client.specialRequests || "").trim(),
  };
}

function localAvailability(date) {
  const day = new Date(`${date}T18:30:00`);
  const weekday = day.getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { date, slots: [] };
  }
  const records = readBookingRecords();
  const bookedTimes = new Set(records.filter(record => record?.client?.date === date && ["pending_manual_payment", "deposit_paid", "deposit_confirmed"].includes(record.status)).map(record => record.client.time));
  const regular = isWeekend || holidayDates.has(date)
    ? []
    : regularAppointmentTimes.map(time => ({ time, status: bookedTimes.has(time) ? "booked" : "open", emergency: false, note: "Regular evening appointment" }));
  const emergency = emergencyProposalTimes.map(time => ({ time, status: bookedTimes.has(time) ? "booked" : "open", emergency: true, note: "Emergency proposal outside normal hours (+$45)" }));
  return { date, slots: [...regular, ...emergency] };
}

function availabilityForDate(date) {
  return localAvailability(date);
}

function pricedCartItem(item = {}) {
  const exactService = serviceCatalog.find(service => service.id === item.id);
  if (exactService) {
    if (exactService.category === "starter-locs") throw new Error(`Parting preference is required for ${exactService.name}.`);
    if (exactService.category === "loc-maintenance" && !allowedBaseProducts.has(item.baseProduct)) {
      throw new Error(`Base product preference is required for ${exactService.name}.`);
    }
    return {
      ...exactService,
      type: "service",
      baseProduct: allowedBaseProducts.has(item.baseProduct) ? item.baseProduct : undefined,
    };
  }

  const partingService = serviceCatalog.find(service => item.id === `${service.id}-triangle-parts` || String(item.id || "").startsWith(`${service.id}-`));
  if (partingService?.category === "starter-locs") {
    const partingPreference = String(item.partingPreference || "");
    if (!allowedPartingFees.has(partingPreference)) throw new Error(`Invalid parting preference for ${partingService.name}.`);
    const partingFee = allowedPartingFees.get(partingPreference);
    const expectedId = partingFee ? `${partingService.id}-triangle-parts` : `${partingService.id}-${partingPreference.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (item.id !== expectedId) throw new Error(`Invalid cart item option for ${partingService.name}.`);
    return {
      ...partingService,
      id: expectedId,
      name: partingFee ? `${partingService.name} + Triangle Parts` : partingService.name,
      price: partingService.price + partingFee,
      type: "service",
      partingPreference,
      partingFee,
    };
  }

  const product = productCatalog.find(productItem => productItem.id === item.id);
  if (product) return { ...product, type: "product" };

  throw new Error(`Unknown cart item: ${item.id || "missing id"}.`);
}

function priceBooking(booking) {
  const client = sanitizeClient(booking.client);
  const required = ["fullName", "email", "phone", "date", "time"];
  const missing = required.filter(field => !client[field]);
  if (missing.length) throw new Error(`Missing required booking fields: ${missing.join(", ")}.`);
  const slot = availabilityForDate(client.date).slots.find(item => item.time === client.time);
  if (!slot) throw new Error("Selected appointment time is not available.");
  if (slot.status === "booked") throw new Error("That appointment time was just booked. Please choose another time.");
  if (!Array.isArray(booking.cart) || booking.cart.length === 0) throw new Error("Booking must include at least one cart item.");
  if (!booking.policyAcknowledgement) throw new Error("Policy acknowledgement is required.");

  const cart = booking.cart.map(pricedCartItem);
  if (client.emergencySlot && !cart.some(item => item.id === "emergency-fee")) {
    const emergencyFee = serviceCatalog.find(service => service.id === "emergency-fee");
    if (emergencyFee) cart.push({ ...emergencyFee, type: "service", autoEmergencyFee: true });
  }
  const selectedServices = cart.filter(item => item.type === "service");
  const addOns = cart.filter(item => item.type !== "service");
  const subtotal = cart.reduce((sum, item) => sum + item.price, 0);
  const saleDiscount = activeDiscountForCode(booking.discountCode);
  const clientCredit = availableClientCredit(client, subtotal);
  const referredClientDiscount = referredNewClientDiscount(client, subtotal, selectedServices);
  const discount = isAdminTestBooking(cart) ? null : chooseBookingDiscount(subtotal, saleDiscount, clientCredit, referredClientDiscount);
  const discountAmount = isAdminTestBooking(cart) ? 0 : discountAmountForTotal(subtotal, discount);
  const total = Math.max(0, subtotal - discountAmount);
  const deposit = isAdminTestBooking(cart) ? 0 : Math.max(Math.round(total * 0.3), 30);

  return {
    client,
    cart,
    selectedServices,
    addOns,
    subtotal,
    discountCode: discount ? discount.code : "",
    discountType: discount ? discount.type : "",
    discountPercent: discount ? discount.percent || 0 : 0,
    discountAmount,
    automaticDiscountCredit: discount?.creditId ? {
      type: discount.type,
      creditId: discount.creditId,
      code: discount.code,
      amountOff: discount.amountOff,
    } : null,
    total,
    deposit,
    policyAcknowledgement: true,
    friendTest: sanitizeFriendTest(booking.friendTest),
  };
}

function sanitizeFriendTest(friendTest = null) {
  if (!friendTest || typeof friendTest !== "object") return null;
  const code = String(friendTest.code || "").trim().toUpperCase();
  if (!code.startsWith("LL-FRIEND-")) return null;
  const completedCheckpoints = clampNumber(friendTest.completedCheckpoints, 0, friendTestCheckpoints.length, 0);
  const missing = Array.isArray(friendTest.missing)
    ? friendTest.missing.filter(item => friendTestCheckpoints.includes(item))
    : friendTestCheckpoints.slice(completedCheckpoints);
  return {
    code,
    campaign: String(friendTest.campaign || friendTestCampaign).trim() || friendTestCampaign,
    slot: clampNumber(friendTest.slot, 1, friendTestCampaignLimit, 1),
    automatic: Boolean(friendTest.automatic),
    startedAt: String(friendTest.startedAt || new Date().toISOString()).trim(),
    visited: Array.isArray(friendTest.visited) ? friendTest.visited.filter(item => friendTestCheckpoints.includes(item)) : [],
    completedCheckpoints,
    totalCheckpoints: friendTestCheckpoints.length,
    percentComplete: clampNumber(friendTest.percentComplete, 0, 100, Math.round(completedCheckpoints / friendTestCheckpoints.length * 100)),
    complete: Boolean(friendTest.complete),
    missing,
    bookingSubmitted: Boolean(friendTest.bookingSubmitted),
  };
}

async function createCheckoutSession(req, booking) {
  const stripe = getStripe();
  const siteUrl = publicSiteUrl(req);
  const serviceNames = booking.selectedServices.map(item => item.name).join(", ") || "Lovely Locs services";
  return stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: booking.client.email,
    phone_number_collection: { enabled: true },
    success_url: `${siteUrl}/?booking=${encodeURIComponent(booking.id)}&session_id={CHECKOUT_SESSION_ID}#payment-success`,
    cancel_url: `${siteUrl}/#services`,
    metadata: {
      bookingId: booking.id,
      clientName: booking.client.fullName.slice(0, 200),
      preferredDate: booking.client.date.slice(0, 200),
      total: String(booking.total),
      deposit: String(booking.deposit),
    },
    payment_intent_data: {
      metadata: {
        bookingId: booking.id,
        clientName: booking.client.fullName.slice(0, 200),
        preferredDate: booking.client.date.slice(0, 200),
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: booking.deposit * 100,
          product_data: {
            name: "Lovely Locs Appointment Deposit",
            description: `Non-refundable deposit for ${serviceNames}`.slice(0, 1000),
          },
        },
      },
    ],
  });
}

async function handleDiscountValidate(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const code = normalizeDiscountCode(body.code || "");
    const discount = activeDiscountForCode(code);
    if (!discount) {
      sendJson(res, 404, { ok: false, error: "That promo code is not active right now." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      code: discount.code,
      percent: discount.percent,
      expiresAt: discount.expiresAt || "",
      message: `${discount.code} applied for ${discount.percent}% off.`,
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleDiscountEmail(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const discount = activeDiscountForCode(body.code || "");
    const email = String(body.email || "").trim();
    if (!email || !discount) {
      sendJson(res, 400, { ok: false, error: "Add an email and an active promo code first." });
      return;
    }
    const siteUrl = publicSiteUrl(req);
    const subject = `${discount.code} from Lovely Locs`;
    const text = [
      `Here is your Lovely Locs promo code: ${discount.code}`,
      `Discount: ${discount.percent}% off`,
      discount.expiresAt ? `Use it by ${discount.expiresAt}.` : "Use it before it changes.",
      `Book here: ${siteUrl}/#services`,
    ].join("\n");
    await sendEmail(email, subject, text);
    sendJson(res, 200, { ok: true, message: `Promo code sent to ${email}.` });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleBooking(req, res) {
  try {
    const raw = await readBody(req);
    const booking = JSON.parse(raw || "{}");
    const pricedBooking = priceBooking(booking);
    const id = `LL-${Date.now()}`;
    const referralCode = normalizeReferralCode(pricedBooking.client.referralCode || referralCodeForClient(pricedBooking.client));
    const referralShareUrl = `${publicSiteUrl(req)}/?ref=${encodeURIComponent(referralCode)}#services`;
    const pendingBooking = {
      id,
      receivedAt: new Date().toISOString(),
      status: pricedBooking.deposit === 0 ? "no_charge_test" : "pending_manual_payment",
      ...pricedBooking,
      referralShareUrl,
      paymentOptions: pricedBooking.deposit === 0 ? [] : [
        {
          id: "venmo",
          label: "Venmo",
          handle: "Confirm current payment tag with Lovely Locs before sending.",
          note: "Send the deposit through Venmo and include your booking ID in the note.",
        },
        {
          id: "apple-pay",
          label: "Apple Pay",
          handle: "Confirm current payment tag with Lovely Locs before sending.",
          note: "Send the deposit through Apple Pay and include your booking ID in the note.",
        },
      ],
    };
    if (pricedBooking.deposit === 0 && isAdminTestBooking(pricedBooking.cart)) {
      const notificationResults = await notifyNoChargeTestBooking(pendingBooking);
      appendBookingRecord({ ...pendingBooking, notificationResults });
      sendJson(res, 200, {
        ok: true,
        id,
        status: pendingBooking.status,
        noCharge: true,
        subtotal: pendingBooking.subtotal,
        discountCode: pendingBooking.discountCode,
        discountPercent: pendingBooking.discountPercent,
        discountAmount: pendingBooking.discountAmount,
        total: pendingBooking.total,
        deposit: pendingBooking.deposit,
        referralCode,
        referralShareUrl,
        message: "Free admin test booking saved. No deposit was requested. Confirmation messages were attempted with the connected providers.",
        notificationResults,
      });
      return;
    }

    appendBookingRecord(pendingBooking);
    reserveDiscountCredit(pendingBooking);
    createPendingReferralReward(pendingBooking);

    sendJson(res, 200, {
      ok: true,
      id,
      status: pendingBooking.status,
      payOptionsUrl: `${publicSiteUrl(req)}/?booking=${encodeURIComponent(id)}&deposit=${encodeURIComponent(pendingBooking.deposit)}#payment-options`,
      paymentOptions: pendingBooking.paymentOptions,
      subtotal: pendingBooking.subtotal,
      discountCode: pendingBooking.discountCode,
      discountPercent: pendingBooking.discountPercent,
      discountAmount: pendingBooking.discountAmount,
      total: pendingBooking.total,
      deposit: pendingBooking.deposit,
      referralCode,
      referralShareUrl,
      friendTest: pendingBooking.friendTest,
      message: "Appointment request saved. Pay options are ready; Lovely Locs will send the official confirmation after the deposit receipt is verified in Gmail.",
    });
  } catch (error) {
    const status = /Stripe Checkout is not configured|Stripe package is not installed/.test(error.message) ? 503 : 400;
    sendJson(res, status, { ok: false, error: error.message });
  }
}

function manualPaymentConfirmLink(bookingId, req) {
  const token = process.env.MANUAL_DEPOSIT_CONFIRM_TOKEN || process.env.AUTOMATION_RUN_TOKEN || "";
  if (!token) return "";
  return `${publicSiteUrl(req)}/api/manual-payment/confirm?booking=${encodeURIComponent(bookingId)}&method=venmo&token=${encodeURIComponent(token)}`;
}

function tokenIsValid(token = "") {
  const expected = process.env.MANUAL_DEPOSIT_CONFIRM_TOKEN || process.env.AUTOMATION_RUN_TOKEN || "";
  return Boolean(expected) && String(token || "") === expected;
}

function automationTokenIsValid(token = "") {
  return tokenIsValid(token);
}

async function handleManualPaymentConfirm(req, res) {
  try {
    const siteUrl = publicSiteUrl(req);
    const url = new URL(req.url || "/", siteUrl);
    const bookingId = String(url.searchParams.get("booking") || "").trim();
    const method = String(url.searchParams.get("method") || "manual").trim();
    const format = String(url.searchParams.get("format") || "html").trim().toLowerCase();
    const token = url.searchParams.get("token") || "";
    if (!tokenIsValid(token)) {
      sendJson(res, 403, { ok: false, error: "Manual deposit token is missing or invalid." });
      return;
    }
    const records = readBookingRecords();
    const booking = findBookingById(bookingId, records);
    if (!booking) {
      sendJson(res, 404, { ok: false, error: "Booking not found." });
      return;
    }
    const alreadyConfirmed = records.some(record => record.type === "manual.deposit.confirmed" && record.bookingId === bookingId);
    let notificationResults = [];
    let referralReward = null;
    let redeemedCredit = null;
    if (!alreadyConfirmed) {
      const confirmation = {
        type: "manual.deposit.confirmed",
        bookingId,
        confirmedAt: new Date().toISOString(),
        method,
      };
      appendBookingRecord(confirmation);
      const paidBooking = {
        ...booking,
        status: "deposit_confirmed",
      };
      const clientEmail = confirmationEmail(paidBooking);
      const ownerText = `Manual deposit confirmed for ${booking.client.fullName}: $${booking.deposit}. Method: ${method}. Preferred date/time: ${booking.client.date} at ${timeLabel(booking.client.time)}.`;
      notificationResults = await runNotificationTasks([
        ["clientEmail", () => sendEmail(booking.client.email, "Your Lovely Locs appointment is confirmed", clientEmail.text, clientEmail.html)],
        ["ownerEmail", () => sendEmail(ownerEmail, `Lovely Locs deposit confirmed: ${booking.client.fullName}`, `${ownerText}\n\n${bookingText(paidBooking)}`, ownerBookingEmail(paidBooking, {
          title: `Manual deposit confirmed for ${booking.client.fullName}`,
          intro: "The client deposit has been verified manually. This booking is ready for the normal confirmation follow-up.",
          ctaUrl: manualPaymentConfirmLink(bookingId, req),
          ctaLabel: "Open deposit confirmation link",
        }))],
        ["ownerSms", () => sendSms(normalizePhone(ownerPhone), ownerText)],
      ]);
      referralReward = approveReferralReward(booking);
      redeemedCredit = redeemDiscountCredit(booking);
    }

    if (format === "json") {
      sendJson(res, 200, {
        ok: true,
        bookingId,
        alreadyConfirmed,
        notificationResults,
        referralReward,
        redeemedCredit,
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;background:#f8f0ea;color:#3b2821;"><h1>Deposit ${alreadyConfirmed ? "already confirmed" : "confirmed"}</h1><p>Booking ${escapeHtml(bookingId)} is ready.</p><p><a href="${escapeHtml(publicSiteUrl(req))}/?booking=${encodeURIComponent(bookingId)}#payment-options">Open booking</a></p></body></html>`);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleAdminBookingLookup(req, res) {
  const siteUrl = publicSiteUrl(req);
  const url = new URL(req.url || "/", siteUrl);
  const bookingId = String(url.searchParams.get("booking") || "").trim();
  const token = String(url.searchParams.get("token") || "").trim();
  if (!tokenIsValid(token)) {
    sendJson(res, 403, { ok: false, error: "Admin token is missing or invalid." });
    return;
  }
  const booking = findBookingById(bookingId);
  if (!booking) {
    sendJson(res, 404, { ok: false, error: "Booking not found." });
    return;
  }
  sendJson(res, 200, { ok: true, booking });
}

async function handleAdminRecentBookings(req, res) {
  const siteUrl = publicSiteUrl(req);
  const url = new URL(req.url || "/", siteUrl);
  const token = String(url.searchParams.get("token") || "").trim();
  if (!tokenIsValid(token)) {
    sendJson(res, 403, { ok: false, error: "Admin token is missing or invalid." });
    return;
  }
  const bookings = readBookingRecords().filter(record => record?.client && Array.isArray(record.cart)).slice(-25).reverse();
  sendJson(res, 200, { ok: true, bookings });
}

async function handleAdminConfirmationResend(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    if (!tokenIsValid(body.token || "")) {
      sendJson(res, 403, { ok: false, error: "Admin token is missing or invalid." });
      return;
    }
    const booking = findBookingById(body.bookingId);
    if (!booking) {
      sendJson(res, 404, { ok: false, error: "Booking not found." });
      return;
    }
    const clientEmail = confirmationEmail(booking, { test: false });
    const result = await sendEmail(booking.client.email, "Your Lovely Locs appointment is confirmed", clientEmail.text, clientEmail.html);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleStripeWebhook(req, res) {
  try {
    const raw = await readBody(req);
    const stripe = getStripe();
    const signature = req.headers["stripe-signature"];
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      sendJson(res, 503, { ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured." });
      return;
    }

    const event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const bookingId = session.metadata?.bookingId;
      const booking = findBookingById(bookingId);
      const notificationResults = booking ? await notifyDepositPaid(booking, session) : [];
      const referralReward = booking ? approveReferralReward(booking) : null;
      const redeemedCredit = booking ? redeemDiscountCredit(booking) : null;
      appendBookingRecord({
        type: "stripe.checkout.session.completed",
        bookingId,
        receivedAt: new Date().toISOString(),
        status: "deposit_paid",
        stripe: {
          checkoutSessionId: session.id,
          paymentIntentId: session.payment_intent || "",
          paymentStatus: session.payment_status || "",
          amountTotal: session.amount_total || 0,
          currency: session.currency || "usd",
        },
        notificationResults,
        referralReward,
        redeemedCredit,
      });
    }

    sendJson(res, 200, { received: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function clientSettingsFor(client, req) {
  const records = readBookingRecords();
  const latest = latestClientBooking(client, records);
  const savedProfile = latestClientProfile(client, records);
  const profile = {
    fullName: String(client.fullName || "").trim(),
    email: String(client.email || "").trim(),
    phone: String(client.phone || "").trim(),
    ...(latest?.client || {}),
    ...(savedProfile?.client || {}),
  };
  const key = clientIdentityKey(profile);
  const referralCode = normalizeReferralCode(referralCodeForClient(profile) || profile.referralCode);
  const siteUrl = publicSiteUrl(req);
  const shareUrl = `${siteUrl}/?ref=${encodeURIComponent(referralCode)}#services`;
  const pendingReferrals = records.filter(record => record.type === "referral.reward.pending" && record.referrerKey === key);
  const approvedReferrals = records.filter(record => record.type === "referral.reward.approved" && record.clientKey === key);
  const credits = records.filter(record => (
    ["referral.reward.approved", "birthday.reward.approved"].includes(record.type)
    && record.clientKey === key
  )).map(record => {
    const reserved = records.some(item => item.type === "discount.credit.reserved" && item.creditId === record.creditId);
    const redeemed = records.some(item => item.type === "discount.credit.redeemed" && item.creditId === record.creditId);
    const expired = creditIsExpired(record);
    return {
      type: record.type === "birthday.reward.approved" ? "birthday" : "referral",
      status: redeemed ? "redeemed" : reserved ? "reserved" : expired ? "expired" : "available",
      creditId: record.creditId,
      discountCode: record.discountCode,
      amountOff: record.amountOff,
      createdAt: record.approvedAt,
      validFrom: record.validFrom || "",
      expiresAt: record.expiresAt || "",
    };
  });
  return {
    ok: true,
    clientFound: Boolean(latest || savedProfile),
    client: {
      fullName: profile.fullName || "",
      email: profile.email || "",
      phone: profile.phone || "",
      birthday: profile.birthday || "",
      locJourneyLength: profile.locJourneyLength || "",
      onboardingCompleted: Boolean(profile.onboardingCompleted || savedProfile),
      googleLinked: Boolean(savedProfile?.googleSubject),
      preferredContact: profile.preferredContact || "text_email",
      smsOptIn: Boolean(profile.smsOptIn),
      marketingEmailOptIn: Boolean(profile.marketingEmailOptIn),
      referralOptIn: Boolean(profile.referralOptIn),
      specialRequests: profile.specialRequests || "",
    },
    referralCode,
    shareUrl,
    referrals: {
      pending: pendingReferrals.map(record => ({
        referredClientName: record.referredClientName || "Pending client",
        referredBookingId: record.referredBookingId,
        amountOff: record.amountOff,
        createdAt: record.createdAt,
        status: "pending_deposit",
      })),
      approved: approvedReferrals.map(record => ({
        referredBookingId: record.referredBookingId,
        amountOff: record.amountOff,
        approvedAt: record.approvedAt,
        status: "approved",
      })),
    },
    credits,
    auth: {
      gmailConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    },
  };
}

async function handleClientSettings(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const client = sanitizeClient({
      fullName: body.fullName || "",
      email: body.email || "",
      phone: body.phone || "",
      date: "2099-01-01",
      time: "18:30",
    });
    if (!client.email || !client.phone) {
      sendJson(res, 400, { ok: false, error: "Enter the email and phone number used for booking." });
      return;
    }
    sendJson(res, 200, clientSettingsFor(client, req));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
}

async function googleSigningKeys(forceRefresh = false) {
  if (!forceRefresh && googleJwksCache.expiresAt > Date.now() && googleJwksCache.keys.length) {
    return googleJwksCache.keys;
  }
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) throw new Error("Google's sign-in keys could not be loaded.");
  const body = await response.json();
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600);
  googleJwksCache = {
    expiresAt: Date.now() + Math.max(300, maxAge) * 1000,
    keys: Array.isArray(body.keys) ? body.keys : [],
  };
  return googleJwksCache.keys;
}

async function verifyGoogleCredential(credential) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) throw new Error("Google sign-in is not configured.");
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw new Error("Google returned an invalid sign-in credential.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Google returned an unsupported sign-in credential.");
  let signingKey = (await googleSigningKeys()).find(key => key.kid === header.kid && key.kty === "RSA");
  if (!signingKey) {
    signingKey = (await googleSigningKeys(true)).find(key => key.kid === header.kid && key.kty === "RSA");
  }
  if (!signingKey) throw new Error("Google's sign-in key could not be verified. Please try again.");
  const publicKey = crypto.createPublicKey({ key: signingKey, format: "jwk" });
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  );
  if (!signatureValid) throw new Error("Google sign-in verification failed.");
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("Google sign-in issuer is invalid.");
  if (!audiences.includes(clientId)) throw new Error("Google sign-in was issued for a different application.");
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now) throw new Error("Google sign-in expired. Please try again.");
  if (claims.iat && Number(claims.iat) > now + 300) throw new Error("Google sign-in time is invalid.");
  if (!claims.email || claims.email_verified !== true) throw new Error("Use a Google account with a verified email address.");
  return claims;
}

async function handleGoogleSignIn(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const claims = await verifyGoogleCredential(body.credential);
    const records = readBookingRecords();
    const savedProfile = latestClientProfileByGoogleSubject(claims.sub, records)
      || latestClientProfileByEmail(claims.email, records);
    const booking = latestClientBookingByEmail(claims.email, records);
    if (!savedProfile && !booking) {
      sendJson(res, 200, {
        ok: true,
        needsSignup: true,
        signup: {
          email: String(claims.email).trim().toLowerCase(),
          fullName: String(claims.name || "").trim(),
        },
      });
      return;
    }
    sendJson(res, 200, {
      ...clientSettingsFor(savedProfile?.client || booking.client, req),
      auth: {
        provider: "google",
        email: String(claims.email).trim().toLowerCase(),
      },
    });
  } catch (error) {
    sendJson(res, 401, { ok: false, error: error.message });
  }
}

async function handleGoogleSignup(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const claims = await verifyGoogleCredential(body.credential);
    const records = readBookingRecords();
    const existingProfile = latestClientProfileByGoogleSubject(claims.sub, records)
      || latestClientProfileByEmail(claims.email, records);
    if (existingProfile) {
      sendJson(res, 200, {
        ...clientSettingsFor(existingProfile.client, req),
        auth: { provider: "google", email: String(claims.email).trim().toLowerCase() },
      });
      return;
    }
    const requestedBirthday = String(body.birthday || "").trim();
    if (requestedBirthday && !/^\d{4}-\d{2}-\d{2}$/.test(requestedBirthday)) {
      sendJson(res, 400, { ok: false, error: "Enter a valid birthday or leave it blank." });
      return;
    }
    const client = sanitizeClient({
      fullName: body.fullName || claims.name || "",
      email: claims.email,
      phone: body.phone || "",
      birthday: requestedBirthday,
      locJourneyLength: body.locJourneyLength || "",
      onboardingCompleted: true,
      date: "2099-01-01",
      time: "18:30",
    });
    if (!client.fullName || phoneDigits(client.phone).length < 10) {
      sendJson(res, 400, { ok: false, error: "Enter your full name and a valid phone number." });
      return;
    }
    client.referralCode = referralCodeForClient(client);
    appendBookingRecord({
      type: "client.profile.saved",
      profileId: `google:${claims.sub}`,
      googleSubject: String(claims.sub || ""),
      clientKey: clientIdentityKey(client),
      client,
      onboardingCompleted: true,
      createdAt: new Date().toISOString(),
    });
    sendJson(res, 201, {
      ...clientSettingsFor(client, req),
      created: true,
      auth: { provider: "google", email: String(claims.email).trim().toLowerCase() },
    });
  } catch (error) {
    sendJson(res, 401, { ok: false, error: error.message });
  }
}

async function handleNotificationTest(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    if (!tokenIsValid(body.token || "")) {
      sendJson(res, 403, { ok: false, error: "Admin token is missing or invalid." });
      return;
    }
    const channel = String(body.channel || "all").trim().toLowerCase();
    const email = String(body.email || ownerEmail).trim();
    const phone = normalizePhone(body.phone || ownerPhone);
    const tasks = [];
    const stamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    if (channel === "all" || channel === "email") {
      tasks.push(["ownerEmail", () => sendEmail(email, "Lovely Locs notification test", `Lovely Locs test email sent at ${stamp}. If you see this, email notifications are working.`)]);
    }
    if (channel === "all" || channel === "sms") {
      tasks.push(["ownerSms", () => sendSms(phone, `Lovely Locs test text sent at ${stamp}.`)]);
    }
    if (!tasks.length) {
      sendJson(res, 400, { ok: false, error: "Choose email, SMS, or both." });
      return;
    }
    sendJson(res, 200, { ok: true, results: await runNotificationTasks(tasks) });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function runAutomations({ type }) {
  const records = readBookingRecords();
  const bookings = records.filter(record => record?.client && Array.isArray(record.cart));
  const results = [];
  if (["all", "birthday", "daily"].includes(type)) {
    const today = new Date();
    for (const booking of bookings) {
      const reward = ensureBirthdayReward(booking, records, today);
      if (!reward) continue;
      const notificationResults = await runNotificationTasks([
        ["clientEmail", () => sendEmail(booking.client.email, "Lovely Locs birthday credit is ready", `Happy birthday season from Lovely Locs. Your $${birthdayCreditAmount} credit is ready for your next eligible booking.`)],
      ]);
      results.push({
        sent: true,
        automationType: "birthday_credit",
        bookingId: booking.id,
        cycleKey: reward.cycleKey,
        notificationResults,
      });
      records.push(reward);
    }
  }
  return {
    ok: true,
    type,
    checkedBookings: bookings.length,
    sent: results.filter(result => result?.sent).length,
    skipped: results.filter(result => result?.skipped).length,
    results,
  };
}

async function handleAutomationRun(req, res) {
  try {
    const siteUrl = publicSiteUrl(req);
    const url = new URL(req.url || "/", siteUrl);
    let body = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const token = body.token || url.searchParams.get("token") || bearer;
    if (!process.env.AUTOMATION_RUN_TOKEN && !process.env.MANUAL_DEPOSIT_CONFIRM_TOKEN) {
      sendJson(res, 503, { ok: false, error: "AUTOMATION_RUN_TOKEN is not configured." });
      return;
    }
    if (!automationTokenIsValid(token)) {
      sendJson(res, 403, { ok: false, error: "Automation token is missing or invalid." });
      return;
    }
    const type = String(body.type || url.searchParams.get("type") || "daily").trim().toLowerCase();
    const validTypes = new Set(["all", "daily", "monthly", "referral-campaign", "deposit", "appointment", "review", "referral", "birthday"]);
    if (!validTypes.has(type)) {
      sendJson(res, 400, { ok: false, error: "Unknown automation type." });
      return;
    }
    sendJson(res, 200, await runAutomations({ type }));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function automationProviderStatus() {
  const configuredForSms = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  const blockedReason = smsBlockedReason();
  const email = emailReadiness();
  return {
    tokenConfigured: Boolean(process.env.AUTOMATION_RUN_TOKEN || process.env.MANUAL_DEPOSIT_CONFIRM_TOKEN),
    emailConfigured: email.configured,
    emailReadyForClients: email.clientReady,
    emailReadinessReason: email.reason,
    smsConfigured: configuredForSms,
    smsReady: configuredForSms && !blockedReason,
    smsBlockedReason: blockedReason,
    dailyTypes: ["deposit", "appointment", "review", "referral", "birthday"],
    monthlyTypes: ["referral-campaign"],
  };
}

function startAutomationLoop() {
  if (process.env.AUTOMATION_AUTO_RUN !== "true") return;
  const runDaily = () => runAutomations({ type: "daily" }).catch(error => {
    console.error(`Lovely Locs automation run failed: ${error.message}`);
  });
  const firstRun = setTimeout(runDaily, 60 * 1000);
  const interval = setInterval(runDaily, 12 * 60 * 60 * 1000);
  if (firstRun.unref) firstRun.unref();
  if (interval.unref) interval.unref();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url || "").split("?")[0] === "/healthz") {
    sendJson(res, 200, { ok: true, service: "lovely-locs" });
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/notification-status") {
    const configuredForSms = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
    const blockedReason = smsBlockedReason();
    const email = emailReadiness();
    sendJson(res, 200, {
      ok: true,
      emailConfigured: email.configured,
      emailReadyForClients: email.clientReady,
      emailReadinessReason: email.reason,
      emailDeliveryTrackingConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET),
      emailDeliveryTrackingReason: process.env.RESEND_WEBHOOK_SECRET
        ? "Signed Resend delivery webhooks are configured."
        : "Set RESEND_WEBHOOK_SECRET after registering the production webhook.",
      confirmationFromEmail: email.from || configuredEmailAddress(process.env.CONFIRMATION_FROM_EMAIL || ""),
      ownerEmail,
      smsConfigured: configuredForSms,
      smsReady: configuredForSms && !blockedReason,
      smsBlockedReason: blockedReason,
      automation: automationProviderStatus(),
    });
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/automation-status") {
    sendJson(res, 200, { ok: true, ...automationProviderStatus() });
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/site-settings") {
    sendJson(res, 200, { ok: true, settings: readSiteSettings() });
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/auth/google/config") {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
    sendJson(res, 200, { ok: true, configured: Boolean(clientId), clientId });
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/site-settings") {
    readBody(req).then(raw => {
      const body = JSON.parse(raw || "{}");
      if (!tokenIsValid(body.token || "")) {
        sendJson(res, 403, { ok: false, error: "Admin token is missing or invalid." });
        return;
      }
      const settings = saveSiteSettings({ logo: body.logo, discount: body.discount });
      sendJson(res, 200, { ok: true, settings });
    }).catch(error => {
      sendJson(res, 400, { ok: false, error: error.message });
    });
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/discount/validate") {
    handleDiscountValidate(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/discount/email") {
    handleDiscountEmail(req, res);
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/availability") {
    const siteUrl = publicSiteUrl(req);
    const url = new URL(req.url || "/", siteUrl);
    const date = String(url.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { ok: false, error: "A valid date is required." });
      return;
    }
    sendJson(res, 200, { ok: true, ...availabilityForDate(date) });
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/bookings") {
    handleBooking(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/client-settings") {
    handleClientSettings(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/auth/google") {
    handleGoogleSignIn(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/auth/google/signup") {
    handleGoogleSignup(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/notifications/test") {
    handleNotificationTest(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/stripe/webhook") {
    handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/resend/webhook") {
    handleResendWebhook(req, res);
    return;
  }

  if (["GET", "POST"].includes(req.method) && (req.url || "").split("?")[0] === "/api/automations/run") {
    handleAutomationRun(req, res);
    return;
  }

  if (["GET", "POST"].includes(req.method) && (req.url || "").split("?")[0] === "/api/manual-payment/confirm") {
    handleManualPaymentConfirm(req, res);
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/admin/booking") {
    handleAdminBookingLookup(req, res);
    return;
  }

  if (req.method === "GET" && (req.url || "").split("?")[0] === "/api/admin/bookings") {
    handleAdminRecentBookings(req, res);
    return;
  }

  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/admin/confirmation/resend") {
    handleAdminConfirmationResend(req, res);
    return;
  }

  const rawPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const requested = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const filePath = path.resolve(root, requested);

  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Lovely Locs site running at http://${shownHost}:${port}/`);
  startAutomationLoop();
});
