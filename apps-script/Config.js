/**
 * Config.js - all constants, Script-Property secret access, and feature flags.
 *
 * NOTHING else in the codebase reads PropertiesService directly; everything goes through
 * here so secrets have exactly one access path and flags have one definition. No secret
 * literals in this file - only keys and defaults.
 *
 * Owner: backend. See docs/ARCHITECTURE.md section 5 and docs/CONTRACTS.md section 5.
 *
 * Public surface:
 *   CFG                          - non-secret constants (tab names, enums, brand colours,
 *                                  recipient lists, per-entity company info, system defaults).
 *   PROP / FLAG                  - Script-Property key names (spelled ONCE, here).
 *   prop_(key, required)         - String  read one Script Property (throws if required+missing).
 *   optProp_(key)                - String  read one Script Property or '' if unset.
 *   flag_(name, dflt)            - Boolean read a feature flag ('1'/'true' => true).
 *   DRY_RUN_()                   - Boolean convenience for the DRY_RUN flag (default TRUE).
 *   offboardArmed_/hubspotSeatEnabled_/propdataLive_ - the three named safety flags.
 *   sheet_()                     - Spreadsheet the shared tracker (by TRACKER_SHEET_ID prop).
 *   tab_(name)                   - Sheet   a tab on the tracker by name (throws if absent).
 *
 * Feature-flag defaults are the SAFE ones: DRY_RUN on, everything destructive/paid off.
 */

/** Script-Property key names for secrets + ids. Spelled ONCE, here. */
var PROP = {
  // Supabase (quay-clock project, shared with Aqua + the dashboards).
  SUPABASE_URL: 'SUPABASE_URL',
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  SUPABASE_SERVICE_KEY: 'SUPABASE_SERVICE_KEY',
  // The one shared tracker Sheet (Onboarding + both queue tabs).
  TRACKER_SHEET_ID: 'TRACKER_SHEET_ID',
  // This deployment's own /exec url (used to build the candidate FICA + induction links).
  WEBAPP_URL: 'WEBAPP_URL',
  // External-system secrets.
  HUBSPOT_TOKEN: 'HUBSPOT_TOKEN',
  PROPDATA_API_KEY: 'PROPDATA_API_KEY',
  PROPDATA_VENDOR_ID: 'PROPDATA_VENDOR_ID',
  // Quay 1 contract template + Drive parent (Blocker B1: set via setup, never hardcoded).
  QUAY1_TEMPLATE_SALE: 'QUAY1_TEMPLATE_SALE',
  QUAY1_TEMPLATE_RENTAL: 'QUAY1_TEMPLATE_RENTAL',
  QUAY1_PARENT_FOLDER: 'QUAY1_PARENT_FOLDER',
  // Aqua MOA templates (monthly | fixed | permanent) + Drive parent.
  AQUA_TEMPLATE_MONTHLY: 'AQUA_TEMPLATE_MONTHLY',
  AQUA_TEMPLATE_FIXED: 'AQUA_TEMPLATE_FIXED',
  AQUA_TEMPLATE_PERMANENT: 'AQUA_TEMPLATE_PERMANENT',
  AQUA_PARENT_FOLDER: 'AQUA_PARENT_FOLDER',
  // team -> [google group emails] map, JSON. Read by Provisioning for Members.insert.
  GROUPS_JSON: 'GROUPS_JSON',
  // where to transfer/revoke Drive on offboard (a Workspace admin address), optional.
  DRIVE_TRANSFER_TO: 'DRIVE_TRANSFER_TO',
  // The company "Quay 1 - HR Information Sheet" (owned by lieze@). Onboarding rows are mirrored to
  // its automated tabs (see Hr.js). Optional: Hr.js falls back to the known id when this is unset.
  HR_SHEET_ID: 'HR_SHEET_ID',
  // The provisioning worker's Google service-account email (client_email from its key file). When set,
  // a full-status agent's FICA headshot is shared with it at enqueue so the worker can download the
  // photo and build the branded profile picture. Unset -> no share (worker falls back to the logo).
  WORKER_SA_EMAIL: 'WORKER_SA_EMAIL',
};

/** Feature-flag Script-Property keys (read via flag_ / the named helpers below). */
var FLAG = {
  DRY_RUN: 'DRY_RUN',
  OFFBOARD_ARMED: 'OFFBOARD_ARMED',
  HUBSPOT_SEAT_ENABLED: 'HUBSPOT_SEAT_ENABLED',
  PROPDATA_LIVE: 'PROPDATA_LIVE',
  // HR Information Sheet mirror (Hr.js). Independent of DRY_RUN so HR writes can be validated /
  // armed on their own without also arming Google/PropData account creation. Default OFF (safe).
  HR_SYNC_ENABLED: 'HR_SYNC_ENABLED',
  // Master switch for ALL internal-directed mail: CC/BCC copies (senior brokers, ALWAYS_CC), the
  // CMA/Dialfire approver requests, and the HubSpot team-login alert. Default ON. Set to 0 for a
  // clean end-to-end test so a run never emails real colleagues; candidate-facing mail still sends.
  CC_ENABLED: 'CC_ENABLED',
};

/** Non-secret constants shared across modules. */
var CFG = {
  DOMAIN: 'quay1.co.za',

  // Company-wide Google group EVERY onboarded broker is added to (on top of their team group).
  COMPANY_GROUP: 'champions@quay1.co.za',

  ENTITIES: ['quay1', 'aqua'],

  // Per-entity company info used by the contract + email builders.
  COMPANY: {
    quay1: { name: 'Quay 1', full: 'Quay 1 International Realty', kicker: 'Broker Agreement' },
    aqua: { name: 'Aqua Promotions', full: 'Aqua Promotions (Pty) Ltd', kicker: 'Memorandum of Agreement' },
  },

  // Quay 1 brand palette. Both entities' live emails use navy + gold (see RESEARCH 2.7); the
  // frontend Aqua-gold surface theme is a UI decision, not used by these transactional emails.
  BRAND: {
    navy: '#3D5BA6', navyDark: '#2E477F', gold: '#FDC503', goldInk: '#2A2100',
    ink: '#1F2A44', slate: '#4B4636', paper: '#EEF3FA', muted: '#7A7358',
    green: '#1E7A46', greenT: '#E6F4EA', greenB: '#B7DEC9',
    amber: '#8A6D1B', amberT: '#FFF8E6', red: '#B42318',
  },

  // Tab names on the shared tracker Sheet (mirror docs/CONTRACTS.md).
  TAB: {
    ONBOARDING: 'Onboarding',
    PROVISION_QUEUE: 'Provisioning Queue',
    OFFBOARD_QUEUE: 'Offboarding Queue',
    // team -> Google groups / division / systems map, editable in the tracker (B.3). Auto-seeded
    // (Team + Division) from the shared divisions directory; the Groups/Systems cols are filled in
    // by an admin. Read by teamMapping_ for Google provisioning + the divisions update.
    TEAM_DIRECTORY: 'Team Directory',
    // Account rosters powering the Programs page (who holds CMA / PropData accounts). Refreshed by
    // pasting the periodic exports. Kept in the PRIVATE tracker, never the public repo. Read by
    // Programs.js. CMA Accounts: any @ email = a holder. PropData Accounts: the raw agents export
    // (First Name / Last Name / Email / Active; a "Quay 1 Property Specialist" first-name marks a
    // numbered specialist profile, its number = Last Name).
    CMA_ACCOUNTS: 'CMA Accounts',
    PROPDATA_ACCOUNTS: 'PropData Accounts',
    // Superuser-readable ledger of every Google account created + its temp password. Lives in the
    // PRIVATE tracker (only admins/superusers can open it), so sheet sharing IS the access control.
    // Written by recordCredential_ on a live googleCreate_; upsert by quay_email (no duplicates).
    CREDENTIALS: 'Google Credentials',
  },
  // Public divisions directory (the dashboards' data file), fetched to seed the Team Directory tab.
  DIVISIONS_URL: 'https://twigs002.github.io/quay-1-onoff-boarding-tool/data/divisions.json',

  // Enum vocabulary (mirror docs/CONTRACTS.md section 5). Import these exact strings.
  SYSTEMS: ['google', 'propdata', 'cma', 'dialfire', 'hubspot'],
  // PropData moved from inline REST to the browser worker (PDMS has no usable user API);
  // see worker/provisioners/propdata.py. Google is the only remaining inline (API) system.
  // CMA stays a worker system for the OFFBOARD (deactivate) path, but CMA CREATE is never actually
  // performed automatically (it costs money + is OTP-gated): the create row just skips, and an
  // approval-request email is sent to CMA_APPROVERS on admin acceptance instead (see _maybeRequestCma_).
  WORKER_SYSTEMS: ['propdata', 'cma', 'dialfire'],
  INLINE_SYSTEMS: ['google'],
  ACTIONS: ['create', 'deactivate'],
  QUEUE_STATUS: ['pending', 'in_progress', 'done', 'error', 'skipped'],
  OFFB_STATUS: ['scheduled', 'firing', 'done', 'error'],
  // FFC (Fidelity Fund Certificate) status the candidate self-declares on the FICA page. 'full' (a
  // valid FFC holder) -> a full PropData agent profile (photo+name+phone+email); 'candidate' (working
  // towards it) and 'none' -> a numbered PropData specialist profile. See propdataProfileType_.
  FFC_STATUSES: ['full', 'candidate', 'none'],

  // Systems provisioned by DEFAULT for a new hire per entity (RESEARCH 1.4 flags the program
  // -> system mapping as the architect's call; this is that decision). Aqua contractors get
  // Google only by default.
  CORE_SYSTEMS: {
    quay1: ['google', 'propdata'],
    aqua: ['google'],
  },
  // Broker-facing program toggle -> lifecycle SYSTEM (RESEARCH 1.4). Only these two overlap the
  // SYSTEMS enum; whatsapp / training / other are informational and enqueue no provisioning row.
  PROGRAM_SYSTEM: { cma: 'cma', dialfire: 'dialfire' },

  // ENTITLEMENTS MATRIX (contract-type -> systems). Keyed by broker ROLE read off the broker-activity
  // value: 'sb' = full Broker, 'jb' = Assistant. Each entry lists the systems that role must NOT be
  // provisioned - a filter applied to the resolved CREATE set, even if an operator explicitly ticks
  // a barred system. Assistants (JB) work under a senior broker's listings/CMA, so they are barred
  // from CMA; full brokers (SB) get everything. Google is never barred. Revoke is
  // offboarding-only (no mid-life reconcile) - this gates CREATE. A role not listed bars nothing.
  ENTITLEMENTS_BARRED: {
    sb: [],
    jb: ['cma'],
  },

  // Broker Activities - the residential clause definitions from the Quay 1 Broker Agreement
  // template ("delete inapplicable definition" table; the chosen one is kept). Ported verbatim
  // from the live recruitment frontend (quay-hubspot app.js BROKER_ACTIVITIES). `code` is the
  // machine value the form sends; `def` is the exact clause text merged into {{BROKER_ACTIVITY}}.
  // Commercial is parked (no commercial template yet), so it stays out of the picker.
  BROKER_ACTIVITIES: [
    { code: 'sell_res_sb', label: 'Sell · Residential · Broker (SB)', def: 'The selling and/or brokerage of immovable residential property or a broker performing his/her/their functions to such an end; and/or' },
    { code: 'sell_res_jb', label: 'Sell · Residential · Assistant (JB)', def: 'The selling and/or brokerage of immovable residential property or an assistant to a broker performing his/her/their functions to such an end; and/or' },
    { code: 'rent_res_sb', label: 'Rent · Residential · Broker (SB)', def: 'The renting and/or brokerage for rent of immovable residential property or a broker performing his/her/their functions to such an end; and/or' },
    { code: 'rent_res_jb', label: 'Rent · Residential · Assistant (JB)', def: 'The renting and/or brokerage for rent of immovable residential property or an assistant to a broker performing his/her/their functions to such an end; and/or' },
  ],

  // Contract welcome-email CC, per entity. Quay 1 recruitment matches the LIVE pipeline exactly:
  // kat + pagan + lieze (the fixed internal set), plus the senior broker + requester added at
  // send time. Aqua keeps its own set (matches the live Aqua CONFIG). Threaded via _emailContract_.
  CONTRACT_CC: {
    quay1: ['kat@quay1.co.za', 'pagan@quay1.co.za', 'lieze@quay1.co.za'],
    aqua: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'alan@quay1.co.za', 'lieze@quay1.co.za'],
  },

  // Internal recipient lists (internal @quay1 addresses, not secrets; matches live Aqua CONFIG).
  ALWAYS_CC: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'lieze@quay1.co.za'],
  INTERNAL_NOTIFY: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'lieze@quay1.co.za'],
  SYSTEM_PROVISION_TO: ['pagan@quay1.co.za', 'kat@quay1.co.za'],
  // CMA access costs money, so it is not auto-created. When an admin ACCEPTS a CMA-entitled candidate
  // on the Admin Check tab, an approval-request email auto-sends to these approvers (see _maybeRequestCma_).
  // This is a deliberate, scoped exception to the draft-only email rule (the user asked for it to send).
  CMA_APPROVERS: ['sheldon@quay1.co.za', 'marthinus@quay1.co.za'],
  // Dialfire has no usable create API (worker DOM unmapped), so like CMA it is a MANUAL account
  // request: on admin acceptance of a Dialfire-entitled starter, a request email (name + team) is
  // sent to these recipients to create the account. Scoped auto-send, same model as CMA_APPROVERS.
  DIALFIRE_APPROVERS: ['alan@quay1.co.za'],

  // Broker-initiated offboarding (phase 1): clicking "Request offboarding" just sends a simple
  // notification to these people; the full destructive offboarding stays super/admin. Extend later.
  OFFBOARD_NOTIFY: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'lieze@quay1.co.za', 'sheldon@quay1.co.za'],

  MAX_ATTEMPTS: 3,
  OFFBOARD_DELAY_MIN: 30,
  // A row still in 'firing' this many minutes after its fire_at is treated as stuck
  // (interrupted mid-fire) and re-fired idempotently by reapOffboarding_.
  OFFBOARD_FIRING_STALE_MIN: 15,

  // Default hours-of-work clause text (verbatim from the live Aqua template).
  DEFAULT_WORK_HOURS: "08:00 to 17:00 from Monday to Friday and include a 30 (thirty) minute's lunch break each day, full time",
};

// ---------------------------------------------------------------- property access

function _scriptProps_() { return PropertiesService.getScriptProperties(); }

/** Read one Script Property. When required and missing/empty, throw a clear error. */
function prop_(key, required) {
  var v = _scriptProps_().getProperty(key);
  v = (v == null) ? '' : String(v);
  if (required && !v) {
    throw new Error('Missing required Script Property: ' + key + '. Run the matching setup* function.');
  }
  return v;
}

/** Read one Script Property or '' if unset (never throws). */
function optProp_(key) { return prop_(key, false); }

/** Read a feature flag. '1' or 'true' (any case) => true; unset => dflt. */
function flag_(name, dflt) {
  var v = _scriptProps_().getProperty(name);
  if (v == null || v === '') return !!dflt;
  return v === '1' || /^true$/i.test(String(v));
}

/** DRY_RUN defaults ON (safe) when unset - nothing mutates a live system unless armed. */
function DRY_RUN_() {
  var v = _scriptProps_().getProperty(FLAG.DRY_RUN);
  if (v == null || v === '') return true;
  return v === '1' || /^true$/i.test(String(v));
}

function offboardArmed_() { return flag_(FLAG.OFFBOARD_ARMED, false); }
function hubspotSeatEnabled_() { return flag_(FLAG.HUBSPOT_SEAT_ENABLED, false); }
function propdataLive_() { return flag_(FLAG.PROPDATA_LIVE, false); }
/** HR-sheet mirror armed? Default OFF (safe) - Hr.js dry-logs until this is set. */
function hrSyncEnabled_() { return flag_(FLAG.HR_SYNC_ENABLED, false); }
/** Internal-directed mail (CC/BCC + approver requests + HubSpot alert) allowed? Default ON. */
function ccEnabled_() { return flag_(FLAG.CC_ENABLED, true); }
/** Turn internal CC/BCC + approver/HubSpot emails OFF (for a clean test). Candidate mail still sends. */
function ccsOff() { _scriptProps_().setProperty(FLAG.CC_ENABLED, '0'); return 'CC/BCC + approver + HubSpot-alert emails OFF (candidate emails still send).'; }
/** Turn internal CC/BCC + approver/HubSpot emails back ON. */
function ccsOn() { _scriptProps_().setProperty(FLAG.CC_ENABLED, '1'); return 'CC/BCC + approver + HubSpot-alert emails ON.'; }

// ---------------------------------------------------------------- sheet access

/** The shared tracker Spreadsheet (by TRACKER_SHEET_ID). Throws if unset. */
function sheet_() {
  return SpreadsheetApp.openById(prop_(PROP.TRACKER_SHEET_ID, true));
}

/** A tab on the tracker by name. Throws if the tab is missing (run setupHub). */
function tab_(name) {
  var sh = sheet_().getSheetByName(name);
  if (!sh) throw new Error('Tracker tab not found: "' + name + '". Run setupHub() to create tabs.');
  return sh;
}
