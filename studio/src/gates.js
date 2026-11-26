// The app's own checks. These call the patent-creator MCP server directly, so a
// result on screen is something the app watched happen, not something a model
// said happened. Every result records the SHA-256 of the exact text it read.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { childEnv } from './env.js';
import { LAYOUT } from './workflow.js';
import { writeInside } from './safe-write.js';

let client = null;
let connecting = null;
let serverPath = null;
let extraEnv = {};
let extraKey = '';
let clientKey = null;
let epoch = 0; // bumped by disconnect(), so a server still starting is not kept

// Search keys from the app's saved keys, passed to the server process
// it starts. A change restarts the server on its next use.
export function setExtraEnv(envObj) {
  const k = JSON.stringify(envObj || {});
  if (k !== extraKey) {
    extraKey = k;
    extraEnv = envObj || {};
  }
}

// The campaign must run the antecedent check (skill Phase 4). Setting it on the
// server the app starts removes the "restart the server" step entirely.
export const SERVER_ENV = { PATENT_ENABLE_ANTECEDENT_CHECK: '1', PYTHONIOENCODING: 'utf-8' };

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function connect(patentCreatorPath) {
  // A server started with other keys is replaced. The old one is taken out of
  // use before it closes, so no call can land on a connection that is closing.
  while (connecting) await connecting.catch(() => {});
  if (client && serverPath === patentCreatorPath && clientKey === extraKey) return client;
  connecting = (async () => {
    const old = client;
    client = null;
    if (old) await old.close().catch(() => {});
    const key = extraKey;
    const transport = new StdioClientTransport({
      command: patentCreatorPath,
      args: ['serve'],
      env: childEnv({ ...SERVER_ENV, ...extraEnv }),
      stderr: 'pipe',
    });
    const c = new Client({ name: 'patent-creator-studio', version: '0.1.0' });
    const startedIn = epoch;
    // The SDK's own transport handler rejects pending calls on close; this
    // only forgets the client.
    c.onclose = () => {
      if (client === c) client = null;
    };
    await c.connect(transport);
    if (startedIn !== epoch) {
      await c.close().catch(() => {});
      throw new Error('The patent tools were stopped.');
    }
    client = c;
    clientKey = key;
    serverPath = patentCreatorPath;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnect() {
  epoch++;
  const old = client;
  client = null;
  if (old) await old.close().catch(() => {});
}

function unwrap(res) {
  if (res.structuredContent) {
    // FastMCP wraps list results as {result: [...]}
    return res.structuredContent.result ?? res.structuredContent;
  }
  const texts = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text);
  const parsed = texts.map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  return parsed.length === 1 ? parsed[0] : parsed;
}

export async function callTool(pcPath, name, args = {}) {
  const c = await connect(pcPath);
  const res = await c.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 });
  const data = unwrap(res);
  if (res.isError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}

export async function searchStatus(pcPath) {
  const [google, epo, uspto, bigquery] = await Promise.all([
    callTool(pcPath, 'check_google_patents_status').catch((e) => ({ ready: false, error: e.message })),
    callTool(pcPath, 'check_epo_api_status').catch((e) => ({ ready: false, error: e.message })),
    callTool(pcPath, 'check_uspto_api_status').catch((e) => ({ ready: false, error: e.message })),
    callTool(pcPath, 'check_bigquery_status').catch((e) => ({ available: false, error: e.message })),
  ]);
  const sources = [google?.ready && 'Google Patents', epo?.ready && 'EPO', uspto?.ready && 'USPTO', bigquery?.available && 'BigQuery'].filter(Boolean);
  const status = { google, epo, uspto, bigquery, ready: !!google?.ready || !!epo?.ready || !!bigquery?.available, sources, checkedAt: new Date().toISOString() };
  return { ...status, reasons: searchReasons(status) };
}

export function searchReasons(status) {
  if (status.error) return ['the patent search check could not finish'];
  return [['google', 'Google Patents'], ['epo', 'EPO'], ['uspto', 'USPTO'], ['bigquery', 'BigQuery']].flatMap(([key, name]) => {
    const source = status[key];
    if (source?.ready || source?.available) return [];
    const text = `${source?.error || ''} ${source?.message || ''}`;
    let reason = 'the service check could not finish';
    if (key === 'google' && typeof source?.searches_left === 'number' && source.searches_left <= 0) reason = 'no searches left this month';
    else if (/quota|limit|429|no .*searches.*left/i.test(text)) reason = 'the usage limit was reached';
    else if (/xmltodict/i.test(text)) reason = 'the patent tools need an update in Setup';
    else if (source?.credentials_configured === false || source?.api_key_configured === false || /not configured|not installed|not set|no .*key|needs a free SerpApi key|set .*environment|GOOGLE_CLOUD_PROJECT|default credentials.*not found/i.test(text)) reason = 'not set up';
    else if (/401|403|unauthori[sz]ed|forbidden|invalid.*key|key.*invalid|invalid_client/i.test(text)) reason = key === 'bigquery' ? 'access was refused' : 'the key was refused';
    else if (/timed?\s*out|timeout/i.test(text)) reason = 'the service took too long to reply';
    else if (/connect|network|ENOTFOUND|ENETUNREACH|fetch|request failed/i.test(text)) reason = 'could not connect to the service';
    else if (/HTTP 5\d\d|server error|unavailable/i.test(text)) reason = 'the service is temporarily unavailable';
    else if (/authentication failed/i.test(text)) reason = key === 'bigquery' ? 'access was refused' : 'the key was refused';
    else if (/unreadable|invalid.*response/i.test(text)) reason = 'the service returned an unreadable reply';
    // USPTO and BigQuery are extras; they are named only when set up and failing.
    if (reason === 'not set up' && (key === 'uspto' || key === 'bigquery')) return [];
    return [`${name}: ${reason}`];
  });
}

function readIf(dir, rel) {
  const p = path.join(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// Strip markdown headings and fences the drafter may add around claims; the
// analyzers expect plain numbered claims.
function plainClaims(md) {
  return md
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l) && !/^\s*```/.test(l))
    .join('\n')
    .trim();
}

export async function runDraftGates(pcPath, dir, stopped = () => false) {
  const claims = readIf(dir, LAYOUT.claims);
  const spec = readIf(dir, LAYOUT.spec);
  const abstract = readIf(dir, LAYOUT.abstract);
  const result = { ranAt: new Date().toISOString(), checks: {} };
  if (!claims) throw new Error(`Claims file missing (${LAYOUT.claims}). Run step 4.`);
  const claimsText = plainClaims(claims);
  result.hashes = { claims: sha256(claims), spec: spec ? sha256(spec) : null, abstract: abstract ? sha256(abstract) : null };

  result.checks.claims = await callTool(pcPath, 'review_patent_claims', { claims_text: claimsText }).catch((e) => ({ error: e.message }));
  if (spec && !stopped()) {
    result.checks.specification = await callTool(pcPath, 'review_specification', { claims_text: claimsText, specification: spec }).catch((e) => ({ error: e.message }));
    const titleLine = spec.split(/\r?\n/).find((l) => l.trim()) || '';
    const title = titleLine.replace(/^#+\s*/, '').trim();
    const figDir = path.join(dir, LAYOUT.figures);
    const drawings = existsSync(figDir) && readdirSync(figDir).some((f) => /\.(svg|pdf|png)$/i.test(f));
    const args = { specification: spec, title, drawings_present: drawings };
    if (abstract) args.abstract = abstract.replace(/^#+.*$/m, '').trim();
    if (!stopped()) result.checks.formalities = await callTool(pcPath, 'check_formalities', args).catch((e) => ({ error: e.message }));
  }
  if (stopped()) return result;
  result.summary = summarize(result);
  writeInside(dir, LAYOUT.gates, JSON.stringify(result, null, 2));
  return result;
}

export async function runPackageGate(pcPath, dir) {
  const pkg = path.join(dir, LAYOUT.packageDir);
  if (!existsSync(pkg)) throw new Error(`Package folder missing (${LAYOUT.packageDir}). Run step 7.`);
  try {
    const res = await callTool(pcPath, 'check_package', { directory: pkg });
    return { ranAt: new Date().toISOString(), result: res, error: res?.error || null };
  } catch (e) {
    return { ranAt: new Date().toISOString(), result: null, error: e.message };
  }
}

function count(obj, key) {
  const v = obj?.[key];
  return typeof v === 'number' ? v : null;
}

// A check that errored, or returned no count, is reported as such. Nothing
// unknown is ever treated as passed (see readiness in campaign.js).
function errOf(r) {
  if (!r) return 'not run';
  if (typeof r !== 'object' || Array.isArray(r)) return 'unreadable result';
  return r.error ? String(r.error) : null;
}

export function summarize(r) {
  const c = r.checks.claims;
  const s = r.checks.specification;
  const f = r.checks.formalities;
  const antecedentRan = (c?.checks_run || []).includes('antecedent_basis');
  return {
    claimCount: c?.claim_count ?? null,
    claimsCritical: count(c, 'critical_issues'),
    claimsImportant: count(c, 'important_issues'),
    claimsError: errOf(c),
    antecedentRan,
    specCritical: count(s, 'critical_issues'),
    specError: s === undefined ? 'no description file yet' : errOf(s),
    formalitiesCritical: count(f, 'critical_issues'),
    formalitiesCompliant: f?.overall_compliant === true,
    claimsSkipped: (c?.checks_skipped || []).map((k) => k.check),
    formalitiesError: f === undefined ? 'no description file yet' : errOf(f),
    skipped: [...(c?.checks_skipped || []), ...(s?.checks_skipped || []), ...(f?.checks_skipped || [])],
  };
}
