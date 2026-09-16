// Apps Script global service mocks for the offline node harness.
//
// Apps Script code runs against globals (SpreadsheetApp, AdminDirectory,
// UrlFetchApp, ScriptApp, ContentService, PropertiesService, Utilities, Logger,
// Gmail/MailApp, DriveApp) that don't exist in node. This module builds simple
// in-memory stubs. Two ways to use them:
//
//   install()  -> assigns the stubs onto globalThis (for code eval'd in-process)
//   buildServices() -> returns a plain object of the stubs to seed a `vm` context
//                      (how load_gas.js loads the real apps-script/*.js files)
//
// Every stub RECORDS calls instead of performing them, so tests can assert:
//   - which sheet rows were written (and in what column order)
//   - that DRY_RUN suppressed real external calls (UrlFetchApp / AdminDirectory)
//   - that offboarding scheduled a +30min trigger exactly once
//   - that no email was ever really sent (never-auto-send)
//
// Nothing here ever touches the network or a real spreadsheet.

function ensure(rows, r, c) {
  while (rows.length < r) rows.push([]);
  const line = rows[r - 1];
  while (line.length < c) line.push('');
}

function makeSheet(name) {
  const rows = []; // array of arrays == the tab's grid
  return {
    _name: name,
    _rows: rows,
    getName: () => name,
    appendRow(row) { rows.push(row.slice()); return this; },
    setFrozenRows() { return this; },
    getLastRow: () => rows.length,
    getLastColumn: () => (rows.length ? rows[0].length : 0),
    getRange(r, c, numR = 1, numC = 1) {
      return {
        setValue(v) { ensure(rows, r, c); rows[r - 1][c - 1] = v; return this; },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            for (let j = 0; j < vals[i].length; j++) {
              ensure(rows, r + i, c + j);
              rows[r + i - 1][c + j - 1] = vals[i][j];
            }
          }
          return this;
        },
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getValues() {
          const out = [];
          for (let i = 0; i < numR; i++) {
            const line = [];
            for (let j = 0; j < numC; j++) line.push((rows[r + i - 1] || [])[c + j - 1]);
            out.push(line);
          }
          return out;
        },
      };
    },
    getDataRange() {
      return {
        getValues: () => rows.map((x) => x.slice()),
        getDisplayValues: () => rows.map((x) => x.map((v) => (v == null ? '' : String(v)))),
      };
    },
  };
}

// Build the full set of GAS service stubs plus the shared recording state.
// `props` seeds Script Properties (so Config.prop_/flag_ can be steered).
// `authUser`, when set, makes UrlFetchApp answer the Supabase /auth/v1/user +
// /rest/v1/staff calls with that user so Auth.verifyCaller_ resolves a role -
// lets the harness drive the real doPost end-to-end without a live Supabase.
function buildServices({ dryRun = true, props = {}, authUser = null } = {}) {
  const calls = {
    urlFetch: [],       // every UrlFetchApp.fetch — must stay empty when dryRun
    adminDirectory: [], // every AdminDirectory.* mutating call
    triggers: [],       // ScriptApp trigger builders (live handles)
    deletedTriggers: [],
    emailsDrafted: [],  // Gmail/Mail draft creations
    emailsSent: [],     // real sends — must stay empty (never-auto-send)
    logs: [],
  };
  const sheets = {};
  const getSheet = (n) => (sheets[n] = sheets[n] || makeSheet(n));
  const scriptProps = Object.assign({}, props);

  const spreadsheet = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => getSheet(n),
    getId: () => 'MOCK_SHEET_ID',
  };

  let triggerSeq = 0;

  const services = {
    __DRY_RUN__: dryRun,
    console,
    SpreadsheetApp: {
      _sheets: sheets,
      _spreadsheet: spreadsheet,
      openById: () => spreadsheet,
      getActiveSpreadsheet: () => spreadsheet,
    },
    UrlFetchApp: {
      fetch(url, opts) {
        calls.urlFetch.push({ url, opts });
        if (authUser && /\/auth\/v1\/user/.test(url)) {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ id: authUser.id || 'u1' }) };
        }
        if (authUser && /\/rest\/v1\/staff/.test(url)) {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify([authUser]) };
        }
        return { getResponseCode: () => 200, getContentText: () => '{"mock":true}' };
      },
    },
    AdminDirectory: {
      Users: {
        insert(user) { calls.adminDirectory.push({ op: 'Users.insert', user }); return { id: 'MOCK_UID', primaryEmail: user && user.primaryEmail }; },
        update(user, key) { calls.adminDirectory.push({ op: 'Users.update', user, key }); return { id: key }; },
        get(key) { calls.adminDirectory.push({ op: 'Users.get', key }); return { id: key, suspended: false }; },
        remove(key) { calls.adminDirectory.push({ op: 'Users.remove', key }); },
      },
      Members: {
        insert(m, group) { calls.adminDirectory.push({ op: 'Members.insert', m, group }); },
        remove(group, member) { calls.adminDirectory.push({ op: 'Members.remove', group, member }); },
        list(group) { calls.adminDirectory.push({ op: 'Members.list', group }); return { members: [] }; },
      },
    },
    ScriptApp: {
      newTrigger(fn) {
        const builder = { _fn: fn, _after: null };
        const finalize = () => ({
          create() {
            const id = 'TRIG_' + (++triggerSeq);
            calls.triggers.push({ fn: builder._fn, afterMs: builder._after, id });
            return { getUniqueId: () => id };
          },
        });
        const chain = {
          timeBased: () => ({
            after(ms) { builder._after = ms; return finalize(); },
            at() { return finalize(); },
            everyMinutes() { return finalize(); },
          }),
        };
        return chain;
      },
      getProjectTriggers: () => calls.triggers.map((t) => ({
        getUniqueId: () => t.id,
        getHandlerFunction: () => t.fn,
      })),
      deleteTrigger(t) {
        const id = t && t.getUniqueId && t.getUniqueId();
        calls.deletedTriggers.push(id);
        calls.triggers = calls.triggers.filter((x) => x.id !== id);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
        setProperty: (k, v) => { scriptProps[k] = String(v); },
        deleteProperty: (k) => { delete scriptProps[k]; },
        getProperties: () => Object.assign({}, scriptProps),
      }),
    },
    Utilities: {
      getUuid: () => 'MOCK-UUID-' + Math.random().toString(16).slice(2, 10),
      formatDate: (d) => new Date(d).toISOString(),
      sleep: () => {},
      base64Decode: () => [],
      newBlob: () => ({ getBytes: () => [], setName: () => {} }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput(s) {
        return { _text: s, _mime: null, setMimeType(m) { this._mime = m; return this; }, getContent() { return this._text; } };
      },
    },
    Logger: { log: (...a) => { calls.logs.push(a.join(' ')); } },
    LockService: {
      getDocumentLock: () => ({ waitLock: () => true, tryLock: () => true, releaseLock: () => {} }),
      getScriptLock: () => ({ waitLock: () => true, tryLock: () => true, releaseLock: () => {} }),
    },
    GmailApp: {
      createDraft: (to, subj, body, o) => { calls.emailsDrafted.push({ to, subj, body, o }); return { getId: () => 'DRAFT_1' }; },
      sendEmail: (to, subj, body, o) => { calls.emailsSent.push({ to, subj, body, o }); },
    },
    MailApp: { sendEmail: (to, subj, body, o) => { calls.emailsSent.push({ to, subj, body, o }); } },
    DriveApp: {
      getFileById: () => ({ makeCopy: () => ({ getId: () => 'COPY', getUrl: () => 'url' }), setName: () => {} }),
      // A folder that supports the whole shape FICA upload needs: create files, create/find
      // the "FICA documents" subfolder (self-referencing so subfolders are full folders too).
      getFolderById: () => {
        const mk = () => ({
          getId: () => 'F', getUrl: () => 'url',
          createFile: () => ({ getId: () => 'FILE', getUrl: () => 'url' }),
          createFolder: () => mk(),
          getFoldersByName: () => ({ hasNext: () => false, next: () => mk() }),
        });
        return mk();
      },
    },
  };

  return { services, calls, sheets, getSheet, scriptProps, spreadsheet };
}

// Legacy in-process install (assigns onto globalThis). Kept for callers that
// eval GAS code in the node global rather than a vm context.
function install(opts = {}) {
  const built = buildServices(opts);
  const g = globalThis;
  const saved = {};
  for (const [k, v] of Object.entries(built.services)) {
    saved[k] = g[k];
    g[k] = v;
  }
  built.restore = function restore() {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  };
  return built;
}

module.exports = { install, buildServices, makeSheet };
