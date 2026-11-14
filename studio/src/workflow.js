// The campaign is the repo's patent-application-creator skill. This file only
// splits it into steps a person can see, says where each step writes, and adds
// the protocol the app needs to read results back. It adds no legal method.

export const LAYOUT = {
  intake: '00-intake/intake.md',
  audit: '00-intake/disclosure-audit.md',
  candidates: '01-mining/candidates.md',
  gitHistoryDir: '01-mining/git-history',
  sweep: '02-prior-art/sweep.md',
  decision: '03-decision/decision.md',
  claims: '04-claims/claims.md',
  spec: '05-spec/specification.md',
  abstract: '05-spec/abstract.md',
  figures: '05-spec/figures',
  verification: '06-verify/verification.md',
  gates: '06-verify/gates.json',
  noGo: '06-verify/no-go.md',
  examiner: '07-red-team/examiner-attack.md',
  packageReview: '07-red-team/package-review.md',
  packageDir: '08-package',
  filingDir: '08-package/filing-copies',
  coverSheet: '08-package/sb16-cover-sheet-data.md',
  packageReadme: '08-package/README.md',
  questionsDir: 'questions',
  answers: '00-intake/inventor-answers.md',
};

// Each step names the step it builds on (`after`). A step's result stands only
// while that earlier step has not been run again; campaign.js enforces it.
//   sealed      the step's report must stay byte-for-byte what the step left
//   checksDraft the step vouches for the exact claims, description and drawings
//   writes      'draft' steps are all written by one AI; the attack is the other
export const questionsFile = (phaseId) => `${LAYOUT.questionsDir}/${phaseId}.md`;

export const PHASES = [
  {
    id: 'audit',
    n: 0,
    title: 'Your idea and its public history',
    plain:
      'Reviews your answers and public links. Records what you shared and when, so you can check filing deadlines.',
    time: 'About 5 to 15 minutes',
    role: 'draft',
    skillPhase: 'Phase 0 — Intake (any raw material)',
    outputs: [LAYOUT.audit],
    task: `Run Phase 0 of the skill (Intake) for the invention described in ${LAYOUT.intake}.
The intake form is already filled in, so do not re-ask what it answers. Audit the inventor's own public footprint named there (and any you can find on the web) and record every first-disclosure date with its evidence, or "unknown" where you cannot establish it.
Write ${LAYOUT.audit}: a plain-English summary first (what was public, when, and what that means for US and foreign rights), then the evidence table.`,
  },
  {
    id: 'mining',
    n: 1,
    title: 'Identify ideas to investigate',
    plain:
      'Reviews your description, notes or code. Lists specific solutions to investigate for a patent, with reasons to pursue or drop each one.',
    time: 'About 10 to 40 minutes (longer for large code projects)',
    role: 'draft',
    skillPhase: 'Phase 1 — Invention mining (and Phase 1-H when the material is a git repository)',
    outputs: [LAYOUT.candidates],
    after: 'audit',
    task: `Run Phase 1 of the skill (Invention mining). If any material named in ${LAYOUT.intake} is a git repository, also run Phase 1-H (History mining). The app has already saved each repository's full history (messages, dates, changed files and diffs) in ${LAYOUT.gitHistoryDir}/; mine those files. Do not run git yourself.
Write ${LAYOUT.candidates}: a plain-English summary first, then each candidate with mechanism, evidence location, problem solved, conventional alternative beaten, why it is non-obvious, and the triage verdict (pursue / kill) with the screen that decided it, including the first worth-it read.`,
  },
  {
    id: 'sweep',
    n: 2,
    title: 'Search for anything like it',
    plain:
      'Searches patents, papers, products and public code for similar solutions. Lists the sources found and questions still open.',
    time: 'About 15 to 45 minutes',
    role: 'draft',
    skillPhase: 'Phase 2 — Prior art: every outlet, adversarially',
    outputs: [LAYOUT.sweep],
    after: 'mining',
    sealed: true,
    needsSearch: true,
    task: `Run Phase 2 of the skill (Prior art) for every candidate marked pursue in ${LAYOUT.candidates}.
First call check_google_patents_status and check_bigquery_status and record both results at the top of the report. Follow the skill's rule exactly if neither is ready.
Write ${LAYOUT.sweep}: a plain-English summary first, then CLEAN GROUND, KILL ZONES, MANDATORY CLAIM READS and UNRESOLVED LEADS, each item with its source, link and date, and the outlets searched with the date of the search. Follow the skill's language discipline.`,
  },
  {
    id: 'decision',
    n: 3,
    title: 'Is it worth filing?',
    plain:
      'Assesses the search results and how easily competitors could work around a patent. Recommends whether to continue, stop or resolve missing information.',
    time: 'About 5 to 15 minutes',
    role: 'draft',
    skillPhase: 'Phase 2 decision gate and the worth-it screen at post-sweep width',
    outputs: [LAYOUT.decision],
    after: 'sweep',
    sealed: true,
    task: `Apply the skill's Phase 2 decision gate and the worth-it screen at post-sweep width, using ${LAYOUT.sweep}.
Write ${LAYOUT.decision}. Its FIRST line must be exactly one of:
DECISION: GO
DECISION: NO-GO
DECISION: BLOCKED
Use BLOCKED when the patent outlet was not searched (no Google Patents or BigQuery access). For NO-GO, the file is the no-go report the skill describes, including the design-around and the defensive-publication alternative. For GO, name the candidate(s) going forward, the clean ground each independent claim must recite, the design-around cost and detectability, and the provisional-versus-defensive-publication recommendation.`,
  },
  {
    id: 'claims',
    n: 4,
    title: 'Write the claims',
    plain:
      'Drafts the claims: statements of the protection you are asking for. Uses the differences identified in the search.',
    time: 'About 15 to 30 minutes',
    role: 'draft',
    requiresGo: true,
    skillPhase: 'Phase 3 — Claims-first drafting (claims part)',
    outputs: [LAYOUT.claims],
    after: 'decision',
    writes: 'draft',
    task: `Run the claims part of Phase 3 of the skill for the GO candidate(s) in ${LAYOUT.decision}, using the clean ground in ${LAYOUT.sweep}.
Write ${LAYOUT.claims} containing ONLY the numbered claims (no commentary). Put your drafting notes, the source verification of every limitation, and the worth-it re-check in 04-claims/claims-notes.md.`,
  },
  {
    id: 'spec',
    n: 5,
    title: 'Write the description and drawings',
    plain:
      'Drafts a description to support the claims, a short summary called an abstract, and drawings with numbered parts.',
    time: 'About 20 to 45 minutes',
    role: 'draft',
    requiresGo: true,
    skillPhase: 'Phase 3 — Claims-first drafting (specification and figures part)',
    outputs: [LAYOUT.spec, LAYOUT.abstract],
    after: 'claims',
    writes: 'draft',
    task: `Run the specification and figures part of Phase 3 of the skill for the claims in ${LAYOUT.claims}.
Write ${LAYOUT.spec} (the full specification, no commentary), ${LAYOUT.abstract} (abstract only, 50 to 150 words), and the figures into ${LAYOUT.figures}/ using the diagram tools (save outputs there). If the diagram tools report that Graphviz is not installed, draw each figure yourself as a clean black-and-white SVG file with numbered reference labels instead; do not stop for it. Put the manual feature-to-passage chart in 05-spec/support-chart.md.`,
  },
  {
    id: 'verify',
    n: 6,
    title: 'Check and fix the draft',
    plain:
      'Runs draft checks for claim wording, description and format. The AI reviews the findings and fixes problems, including those from a previous second AI review. Then the checks run again.',
    time: 'About 10 to 30 minutes',
    role: 'draft',
    requiresGo: true,
    gatesBefore: true,
    gatesAfter: true,
    skillPhase: 'Phase 4 — Machine verification loop (iterate to clean)',
    outputs: [LAYOUT.verification],
    after: 'spec',
    writes: 'draft',
    checksDraft: true,
    task: `If ${LAYOUT.examiner} or ${LAYOUT.packageReview} exist from an earlier attack, first address every MUST-FIX finding in them (narrow claims or move elements to dependents as the skill says; never invent disclosure) and note each resolution in ${LAYOUT.verification}. Do not edit or delete the attack reports themselves.
An attack that lands is a real finding about the invention, not a failure of this process. Answer it only with narrowing the specification already supports. Then run the skill's worth-it screen again at the narrowed width: could a competitor design around what is left cheaply, and could infringement even be detected? If narrowing cannot answer a landed attack, or what is left is not worth the filing money, do NOT keep drafting. Write ${LAYOUT.noGo} for the inventor in plain English: what the attack found and the references behind it, the narrowest claim the description could still support and what it would and would not cover, why that is not worth filing, and the alternatives (defensive publication so nobody else can patent it, or keeping it as a trade secret), then end with STATUS: no-go.
Then run Phase 4 of the skill. The app has ALREADY run review_patent_claims (with the antecedent check enabled), review_specification and check_formalities on the current files; their results are in ${LAYOUT.gates}. Read them.
Fix every genuine finding in ${LAYOUT.claims}, ${LAYOUT.spec} and ${LAYOUT.abstract} without inventing disclosure. Manually verify each LOW-confidence flag and record a verdict for each in ${LAYOUT.verification}, along with what you changed. You may re-run the tools yourself while fixing, but the app re-runs them after you finish and only its results count.`,
  },
  {
    id: 'package',
    n: 7,
    title: 'Assemble the package for review',
    plain:
      'Assembles draft documents, Word copies, drawings and cover-sheet details. Adds a guide for the patent practitioner reviewing them.',
    time: 'About 10 to 20 minutes',
    role: 'draft',
    requiresGo: true,
    gatesAfter: true,
    skillPhase: 'Phase 6 — Package',
    outputs: [LAYOUT.packageReadme],
    after: 'verify',
    writes: 'draft',
    checksDraft: true,
    usesIntake: true,
    task: `Run Phase 6 of the skill: build ${LAYOUT.packageDir}/. Filing copies go in ${LAYOUT.filingDir}/ (that exact folder name: the package checker recognises filing copies by it), made from the working files: the claims, the specification and the abstract. This app replaces the skill's strip script: write each filing copy with your file tools (no shell or script), copying the working text exactly and leaving out only commentary (bracketed notes, scores, prior-art comparisons, next steps, strategy). The package checker then confirms each filing copy holds nothing else. The app makes drawings.pdf itself from ${LAYOUT.figures}/; do not make it. Write the SB/16 cover-sheet data from ${LAYOUT.intake} to ${LAYOUT.coverSheet}, and write ${LAYOUT.packageReadme}.
Do NOT change ${LAYOUT.claims}, ${LAYOUT.spec}, ${LAYOUT.abstract} or anything in ${LAYOUT.figures}/ in this step: the checks already vouch for those exact files. If you find something wrong in them, say so in your summary and end with STATUS: blocked so the inventor reruns the check step. Record verification status in the README with content-hashed stamps only. The README must not summarize, quote or carry forward the verdict of any earlier attack in ${LAYOUT.examiner} or ${LAYOUT.packageReview}: those reports are replaced on every attack, so the README only says that a second AI attacks this exact package next and where its reports will be. The app makes the Word (.docx) copies of the claims, description and abstract itself from your Markdown filing copies; do not make them, and keep each Markdown filing copy plain (headings, paragraphs, indented claim elements). Never call the package filing-ready: the app decides readiness from its own checks, and a second AI attacks the package next.`,
  },
  {
    id: 'redteam',
    n: 8,
    title: 'Review with a second AI',
    plain:
      'The other AI challenges the claims and checks the assembled files for problems. If fixes are needed, step 6 narrows the claims or says plainly that what is left is not worth filing, then steps 7 and 8 repeat.',
    time: 'About 15 to 30 minutes',
    role: 'review',
    requiresGo: true,
    skillPhase: 'Phase 5 — Two red teams, not one',
    after: 'package',
    sealed: true,
    outputs: [LAYOUT.examiner, LAYOUT.packageReview],
    task: `You are the red team. You did not write this draft. Run Phase 5 of the skill against the files in this folder.
5a: write ${LAYOUT.examiner}: the strongest 102, 103 and 101 attacks on the claims in ${LAYOUT.claims}, armed with the references in ${LAYOUT.sweep}, each with a verdict (lands / does not land) and the narrowing that would answer it. Mark every attack that lands on the claims as written MUST-FIX.
5b: run check_package on ${LAYOUT.packageDir}, then review every file in ${LAYOUT.packageDir} (and the working claims, specification and figures it was built from) as a zero-context reader. Write ${LAYOUT.packageReview} listing each finding with file and quote, marked MUST-FIX or NOTE.
Do NOT edit anything except your two report files. Your job is to find what is wrong, not to fix it.
The LAST line of EACH of your two reports must be exactly "RED TEAM: PASS" if that report has no MUST-FIX finding, otherwise exactly "RED TEAM: FAIL". Nothing may follow it. An attack that lands is a FAIL for ${LAYOUT.examiner}.`,
  },
];

export function phaseById(id) {
  return PHASES.find((p) => p.id === id);
}

export const statusProtocol = (phase) => `
## How this desktop app runs you (Patent Creator Studio)

- You are running ONE phase of the campaign, headless, inside this invention's folder. Your working directory is the folder; write only inside it.
- The inventor is a person, not you. Never list an AI as an inventor.
- Earlier answers from the inventor, if any, are in ${LAYOUT.answers}. Read it before asking anything again.
- If you need a decision or a fact only the inventor has, write the questions in plain English to ${questionsFile(phase.id)} (numbered, each answerable in a sentence), then stop with STATUS: needs-input.
- Keep every file you write readable by someone who is not a lawyer or a programmer: lead with a short plain-English summary.
- The app runs its own deterministic checks and decides readiness. Never write that anything is "filing-ready", "patentable", "verified" (without a content hash) or "good to go".
- These campaign instructions are complete. Do not load unrelated personal skills or instructions you may find on this computer.
- If anything only the inventor can answer blocks the NEXT step, use STATUS: needs-input, not done.
- The very last line of your final message must be exactly one of:
  STATUS: done
  STATUS: needs-input
  STATUS: no-go
  STATUS: blocked: <one-sentence reason>
  Put a two or three sentence plain-English summary for the inventor just above it.
`;

export function parseStatus(text) {
  const lines = String(text || '').trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const m = l.trim().match(/^\**STATUS:\s*(done|needs-input|no-go|blocked)\b:?\s*(.*?)\**$/i);
    if (m) return { status: m[1].toLowerCase(), reason: m[2] || '' };
  }
  return { status: 'unknown', reason: 'The AI did not confirm completion. Review the files before continuing.' };
}

// The verdict is the last non-empty line, exactly. "Do not say RED TEAM: PASS"
// in the body, or PASS followed by more text, is not a pass.
export function parseRedTeam(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] || '').replace(/^\*+|\*+$/g, '').trim();
  if (last === 'RED TEAM: PASS') return 'PASS';
  if (last === 'RED TEAM: FAIL') return 'FAIL';
  return 'NONE';
}

export function parseDecision(text) {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim());
  const m = first?.match(/DECISION:\s*(GO|NO-GO|BLOCKED)/i);
  return m ? m[1].toUpperCase() : null;
}
