// The one model of a campaign. Every screen and every guard asks this file
// the same three questions: is this step's result still standing, may this
// step run now, and how far along is the invention.
//
// A finished step leaves a stamp in the app's records (never in the invention
// folder). A stamp stands only while everything it was based on is unchanged:
// the step before it has not been run again, the files it vouched for hold the
// same bytes, and the inventor's own answers it used are the same.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LAYOUT, PHASES, phaseById, parseDecision, parseRedTeam } from './workflow.js';
import { docxProblems } from './docx-copies.js';
import { figuresHash, DRAWINGS_PDF } from './drawings-pdf.js';
import { fingerprint, linksIn, readFile, DRAFT_SET, REVIEW_SET } from './projects.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// The part of the intake that defines the invention itself.
export function inventionHash(p) {
  const i = p.intake || {};
  return sha(JSON.stringify([i.description || '', i.problem || '', i.how || '', i.materials || []]));
}
// The invention plus what the inventor said about showing it in public: what
// the public-history step (step 0, the root of the chain) works from.
export function disclosureHash(p) {
  const i = p.intake || {};
  return sha(JSON.stringify([inventionHash(p), i.disclosed || '', i.disclosureNotes || '', i.publicLinks || '']));
}
// Everything the inventor told the app (inventors, address, disclosures too).
export function intakeHash(p) {
  return sha(JSON.stringify(p.intake || {}));
}
// Taken when a run STARTS. A step is stamped with the answers it was given,
// so an answer changed while it was running shows up as out of date.
export function basisNow(p) {
  return { disclosure: disclosureHash(p), intake: intakeHash(p) };
}

const FINISHED = ['done', 'done-unconfirmed', 'no-go', 'blocked'];
export const isFinished = (state) => FINISHED.includes(state);

function filesIn(p, rel, re) {
  const d = path.join(p.folder, rel);
  try {
    return readdirSync(d).filter((n) => re.test(n));
  } catch {
    return [];
  }
}

// What a step promised the inventor beyond its report file. Returned in plain
// words; an empty list means everything promised is there.
export function missingDeliverables(p, phase) {
  const out = phase.outputs.filter((rel) => !existsSync(path.join(p.folder, rel))).map((rel) => rel);
  if (phase.id === 'spec' && !filesIn(p, LAYOUT.figures, /\.(svg|png|pdf)$/i).length) out.push(`at least one drawing in ${LAYOUT.figures}/`);
  if (phase.id === 'package') {
    for (const [word, re] of [
      ['claims', /claim/i],
      ['description', /spec|description/i],
      ['abstract', /abstract/i],
      ['drawings (as a PDF)', /(draw|fig).*\.pdf$/i],
    ]) {
      if (!filesIn(p, LAYOUT.filingDir, re).length) out.push(`the filing copy of the ${word} in ${LAYOUT.filingDir}/`);
    }
    for (const w of docxProblems(path.join(p.folder, LAYOUT.filingDir), p.docx)) out.push(`${w} in ${LAYOUT.filingDir}/`);
    let drawingsCurrent = false;
    try {
      drawingsCurrent = !!p.drawings && p.drawings === figuresHash(path.join(p.folder, LAYOUT.figures));
    } catch {}
    if (!drawingsCurrent) out.push(`a current ${DRAWINGS_PDF} made from the drawings (run step 7 to create it)`);
    if (!existsSync(path.join(p.folder, LAYOUT.coverSheet))) out.push(`the cover-sheet details (${LAYOUT.coverSheet})`);
  }
  if (phase.id === 'decision' && !parseDecision(readFile(p, LAYOUT.decision))) out.push(`a clear filing recommendation in ${LAYOUT.decision}`);
  return out;
}

// Called when a step finishes. Everything the stamp will later be held to.
export function makeStamp(p, phase, { state, engine, family, at, searchReady, basis = basisNow(p), afterAt }) {
  // `afterAt` and `basis` are what the run started from, not what is true now.
  const s = { at, state, engine, family, after: phase.after ? afterAt ?? p.stamps?.[phase.after]?.at ?? null : null };
  if (!phase.after) s.disclosure = basis.disclosure;
  if (phase.usesIntake) s.intake = basis.intake;
  if (phase.id === 'spec') s.figures = filesIn(p, LAYOUT.figures, /\.(svg|png|pdf)$/i);
  if (phase.sealed) s.outputs = fingerprint(p, phase.outputs);
  if (phase.checksDraft) s.draft = fingerprint(p, DRAFT_SET);
  if (phase.id === 'sweep') s.searchReady = !!searchReady;
  if (phase.id === 'verify' && state === 'no-go') s.noGo = fingerprint(p, [LAYOUT.noGo]);
  if (phase.id === 'decision') s.decision = parseDecision(readFile(p, LAYOUT.decision));
  if (phase.id === 'redteam') {
    s.review = fingerprint(p, REVIEW_SET);
    // Both reports carry a verdict; one FAIL, or one missing verdict, is a FAIL.
    const a = parseRedTeam(readFile(p, LAYOUT.examiner));
    const b = parseRedTeam(readFile(p, LAYOUT.packageReview));
    s.verdict = a === 'PASS' && b === 'PASS' ? 'PASS' : a === 'NONE' || b === 'NONE' ? 'NONE' : 'FAIL';
    s.verdicts = { examiner: a, package: b };
  }
  return s;
}

const stepName = (id) => {
  const ph = phaseById(id);
  return `step ${ph.n} ("${ph.title}")`;
};

function staleReason(p, phase, st, up) {
  if (phase.after) {
    if (!up.ok) return `${cap(stepName(phase.after))} must finish first.`;
    if (st.after !== p.stamps[phase.after].at) return `${cap(stepName(phase.after))} ran again. Run this step again.`;
  } else if (st.disclosure !== disclosureHash(p)) return 'You changed the description of your idea, or what you said about showing it in public, after this step ran.';
  if (phase.usesIntake && st.intake !== intakeHash(p)) return 'Your answers changed after this step ran.';
  // A step that ended by saying "stop" (no-go, blocked) owes no deliverables.
  // The fix step's no-go owes exactly one thing: the report that explains it.
  // The fix step's no-go stands on its report and the draft it judged.
  if (st.state === 'no-go' && phase.id === 'verify') {
    if (!existsSync(path.join(p.folder, LAYOUT.noGo))) return `Missing: the no-go report (${LAYOUT.noGo}).`;
    if (st.noGo !== fingerprint(p, [LAYOUT.noGo])) return 'The no-go report was changed after the step finished.';
    if (st.draft !== fingerprint(p, DRAFT_SET)) return 'The claims, description or drawings changed after this step said the idea is not worth filing.';
    return null;
  }
  if (st.state === 'no-go' || st.state === 'blocked') return null;
  const gone = missingDeliverables(p, phase);
  if (gone.length) return `Missing: ${gone.join('; ')}.`;
  // Until step 6 vouches for the whole draft, step 5 answers for every drawing it made.
  if (phase.id === 'spec' && !p.stamps.verify) {
    const lost = (st.figures || []).filter((n) => !existsSync(path.join(p.folder, LAYOUT.figures, n)));
    if (lost.length) return `Missing drawings: ${lost.join(', ')}.`;
  }
  if (phase.sealed && st.outputs !== fingerprint(p, phase.outputs)) return 'Its report was changed after the step finished.';
  if (phase.checksDraft && st.draft !== fingerprint(p, DRAFT_SET)) return 'The claims, description or drawings changed after this step finished.';
  if (phase.id === 'redteam' && st.review !== fingerprint(p, REVIEW_SET)) return 'The draft or package changed after the second AI review.';
  if (phase.writes === 'draft' && p.writer && st.family !== p.writer) return 'This step used the other AI. Run it again with the drafting AI.';
  if (phase.id === 'redteam' && st.family === p.writer) return 'The review used the drafting AI. Run it again with the other AI.';
  return null;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// status: running | done | no-go | blocked | stale | needs-input | error | todo
// ok:     the step's result stands and later steps may build on it
// locked: why the step cannot run yet, in plain words (or null)
export function evaluate(p, runningId = null) {
  const steps = {};
  for (const ph of PHASES) {
    const st = p.stamps?.[ph.id];
    const last = p.phases?.[ph.id]?.state;
    const up = ph.after ? steps[ph.after] : null;
    let status = 'todo';
    let note = '';
    if (runningId === ph.id) status = 'running';
    else if (st) {
      const why = staleReason(p, ph, st, up);
      if (why) [status, note] = ['stale', why];
      else status = st.state === 'no-go' ? 'no-go' : st.state === 'blocked' ? 'blocked' : 'done';
    } else if (last === 'needs-input') status = 'needs-input';
    else if (last && last !== 'idle') status = 'error';

    // The search and the decision are finished results whatever they found.
    const ok = !!st && status !== 'stale' && status !== 'running' && (status === 'done' || ph.id === 'sweep' || ph.id === 'decision');
    let locked = null;
    if (up && !up.ok) locked = up.status === 'running' ? `Opens when ${stepName(ph.after)} finishes.` : `Opens after ${stepName(ph.after)} is done.`;
    else if (ph.id === 'claims' && !p.stamps?.sweep?.searchReady) locked = 'Patent search was unavailable. Add a search key in Settings, then run step 2 again.';
    else if (ph.id === 'claims' && p.stamps?.decision?.decision !== 'GO') locked = 'Opens after step 3 recommends filing.';
    steps[ph.id] = { status, note, ok, locked };
  }
  return steps;
}

// Where the inventor should be looking: the first step whose result is not
// standing. When every step stands but the attack found problems, that is the
// step that fixes them.
export function nextStep(p, steps) {
  const open = PHASES.find((ph) => !steps[ph.id].ok);
  if (open) return open.id;
  return p.stamps?.redteam?.verdict === 'PASS' ? 'redteam' : 'verify';
}

const zero = (v) => typeof v === 'number' && v === 0;
const openWords = {
  todo: 'has not been run yet',
  stale: 'needs to be run again',
  'needs-input': 'is waiting for your answers',
  error: 'did not finish',
  blocked: 'is blocked; read its summary',
  running: 'is running now',
};

// Readiness is computed only from the app's own records and the files as they
// are right now. Nothing an AI wrote about itself is taken on trust.
export function readiness(p, steps = evaluate(p)) {
  // Before a decision exists, the one thing to do is the first step in the
  // chain whose result is not standing.
  const firstOpen = ['audit', 'mining', 'sweep', 'decision'].find((id) => !steps[id].ok);
  const early = (detail) => ({ level: 'early', label: 'In progress', detail, decision: null, missing: [`Run ${stepName(firstOpen)}.`] });
  const sweep = steps.sweep;
  const dec = steps.decision;
  if (!sweep.ok) {
    const first = steps[firstOpen];
    return early(first.status === 'needs-input' ? `${cap(stepName(firstOpen))} is waiting for your answers.` : first.status === 'stale' ? `${cap(stepName(firstOpen))} has to be run again. ${first.note}` : 'The search for similar inventions has not finished yet.');
  }
  if (!p.stamps.sweep.searchReady) {
    return { level: 'blocked', label: 'Patent search needed', detail: 'The search ran without access to patents.', decision: null, missing: ['Add a search key in Settings, then run step 2 again.'] };
  }
  if (!dec.ok) {
    return early(dec.status === 'stale' ? `The decision has to be made again. ${dec.note}` : 'The filing recommendation is pending.');
  }
  const decision = p.stamps.decision.decision;
  if (decision === 'NO-GO') {
    return { level: 'nogo', label: 'Finished: not worth filing', detail: 'The AI recommends stopping. Read the decision report for the evidence and alternatives.', decision, missing: [] };
  }
  if (decision !== 'GO') {
    return { level: 'blocked', label: 'Blocked', detail: 'The AI needs more information to make a recommendation.', decision, missing: ['Read the decision report for what to resolve before running step 3 again.'] };
  }

  // A later step can still find the idea is not worth filing once the claims
  // have been narrowed. That outcome replaces the earlier GO on screen.
  const killer = PHASES.find((ph) => ph.requiresGo && steps[ph.id].status === 'no-go');
  if (killer) {
    const where = killer.id === 'verify' ? ` Read the evidence and alternatives in ${LAYOUT.noGo}.` : ' Read its summary for the evidence and alternatives.';
    return { level: 'nogo', label: 'Finished: not worth filing', detail: `${cap(stepName(killer.id))} recommends stopping.${where}`, decision, missing: [] };
  }

  const missing = [];
  // Name the first open step in full; the ones behind it wait on it, so they
  // are one short line, not a wall.
  const open = PHASES.filter((x) => x.requiresGo && steps[x.id].status !== 'done');
  if (open.length) {
    const s = steps[open[0].id];
    missing.push(`${cap(stepName(open[0].id))} ${openWords[s.status] || 'is not done'}.${s.note ? ' ' + s.note : ''}`);
    if (open.length > 1) missing.push(`After that: ${open.slice(1).map((ph) => `step ${ph.n}`).join(', then ')}.`);
  }
  const links = linksIn(p, REVIEW_SET);
  if (links.length) missing.push(`These linked files cannot be used for the checks: ${links.join(', ')}. Replace the links with file copies.`);

  const g = p.gates?.draft;
  if (!g) missing.push('Draft checks have not run. Run step 6.');
  else {
    if (g.fingerprint !== fingerprint(p, DRAFT_SET)) missing.push('The draft changed after its last checks. Run step 6 again.');
    const s = g.summary || {};
    if (!s.antecedentRan) missing.push('The claim reference check did not run. Run step 6 again.');
    for (const [label, err, crit] of [
      ['claim', s.claimsError, s.claimsCritical],
      ['description', s.specError, s.specCritical],
      ['format', s.formalitiesError, s.formalitiesCritical],
    ]) {
      if (err) missing.push(`The ${label} check failed: ${err}. Run step 6 again.`);
      else if (!zero(crit)) missing.push(crit == null ? `The ${label} check returned no problem count. Run step 6 again.` : `Critical ${label} problems: ${crit}. Run step 6 to address them.`);
    }
    const otherSkips = (s.claimsSkipped || []).filter((k) => k !== 'antecedent_basis');
    if (otherSkips.length) missing.push(`Claim checks skipped: ${otherSkips.join(', ')}. Open Checks for details.`);
    if (!s.formalitiesError && !s.formalitiesCompliant) missing.push('The format check has warnings or incomplete results. Open Checks for details.');
  }

  const pg = p.gates?.package;
  if (!pg) missing.push('The package check has not run. Run step 7.');
  else {
    if (pg.error) missing.push(`The package check failed: ${pg.error}. Run step 7 again.`);
    else if (!zero(pg.result?.critical_issues)) missing.push(pg.result?.critical_issues == null ? 'The package check returned no problem count. Run step 7 again.' : `Critical package problems: ${pg.result.critical_issues}. Open Checks for details.`);
    if (pg.fingerprint !== fingerprint(p, [LAYOUT.packageDir])) missing.push('The package changed after it was checked. Run step 7 again.');
  }

  const rt = p.stamps?.redteam;
  if (rt && steps.redteam.status === 'done' && rt.verdict !== 'PASS') {
    missing.push(
      rt.verdict === 'FAIL'
        ? 'The second AI found problems. Run step 6 to address them, then repeat steps 7 and 8.'
        : 'The second AI left a review result unclear. Run step 8 again.'
    );
  }

  if (missing.length) return { level: 'working', label: 'Drafting', detail: 'Still to resolve:', decision, missing };
  return {
    level: 'review',
    label: "Ready for professional review",
    detail: 'The required automated checks passed on these files. The second AI reported no required fixes. This is not legal advice or a promise of a patent. Have a registered patent practitioner review the draft before filing.',
    decision,
    missing: [],
  };
}
