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

// Search keys from the app's keychain storage, passed to the server process
// it starts. A change restarts the server on its next use.
export function setExtraEnv(envObj) {
  const k = JSON.stringify(envObj || {});
  if (k !== extraKey) {
    extraKey = k;
    extraEnv = envObj || {};
    if (client) disconnect();
  }
}

// The campaign must run the antecedent check (skill Phase 4). Setting it on the
// server the app starts removes the "restart the server" step entirely.
export const SERVER_ENV = { PATENT_ENABLE_ANTECEDENT_CHECK: '1', PYTHONIOENCODING: 'utf-8' };

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function connect(patentCreatorPath) {
  if (client && serverPath === patentCreatorPath) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    if (client) await client.close().catch(() => {});
    const transport = new StdioClientTransport({
      command: patentCreatorPath,
      args: ['serve'],
      env: childEnv({ ...SERVER_ENV, ...extraEnv }),
      stderr: 'pipe',
    });
    const c = new Client({ name: 'patent-creator-studio', version: '0.1.0' });
    await c.connect(transport);
    transport.onclose = () => {
      if (client === c) client = null;
    };
    client = c;
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
  if (client) await client.close().catch(() => {});
  client = null;
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
  const [google, bigquery] = await Promise.all([
    callTool(pcPath, 'check_google_patents_status').catch((e) => ({ ready: false, error: e.message })),
    callTool(pcPath, 'check_bigquery_status').catch((e) => ({ ready: false, error: e.message })),
  ]);
  const bqReady = bigquery?.ready ?? bigquery?.available ?? bigquery?.configured ?? false;
  return { google, bigquery, ready: !!google?.ready || !!bqReady, checkedAt: new Date().toISOString() };
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
