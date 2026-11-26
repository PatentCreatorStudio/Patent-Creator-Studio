# Patent Creator Studio

Research an invention and prepare a patent draft for professional review, one step at a time.

Choose Claude Code with a Claude subscription or Anthropic API key, or Codex with a ChatGPT subscription or OpenAI API key. Runs count toward subscription limits; API use is billed separately. Set up both tools for the second AI review.

The app uses this repository's patent workflow and tools. It provides drafts, not legal advice or approval to file. Have a registered patent attorney or agent review your application before filing. Open **Costs and legal help** for fees, deadlines and free assistance.

## Install

Download the file for your computer from the latest release. The step-by-step install for Mac and Windows, including the automatic Mac install (`install-mac.sh`), is in [LANDING.md](LANDING.md#install), which is also the download repo's front page. After the first install, the app updates itself from the sidebar (**Update and restart**: downloads the release asset, checks GitHub's SHA-256 digest, swaps the app, reopens; see `src/updater.js`).

### Requirements

On Windows the app installs for your account only and needs no administrator rights. It needs Windows 10 (version 1809) or newer. Setup installs everything else, including its own copy of Python. Git is optional: without it, step 1 skips reading a code project's history. Graphviz is optional too.

Claude Code needs a paid Claude plan (Pro or higher) or an API key. The free plan doesn't include it.

### First run

In **Setup**, install the patent tools and sign in to Claude Code or Codex. For API billing, add your key in **Settings**. Add a free SerpApi key (Google Patents) or free EPO keys in Settings to search patents. Step 2 waits until one of them works.

## Run from source

```bash
cd studio
npm install
npm start
```

Build the installers with `npm run dist:mac` (on a Mac) or `npm run dist:win`. Output goes to `dist/`.

## The steps

| # | Step | Saved files |
|---|---|---|
| 0 | Your idea and its public history | `00-intake/disclosure-audit.md` |
| 1 | Identify ideas to investigate | `01-mining/candidates.md` |
| 2 | Search for anything like it | `02-prior-art/sweep.md` |
| 3 | Is it worth filing? | `03-decision/decision.md`, plus `03-decision/second-opinion.md` when the first AI recommends continuing |
| 4 | Write the claims | `04-claims/claims.md` |
| 5 | Write the description and drawings | `05-spec/` |
| 6 | Check and fix the draft | `06-verify/` |
| 7 | Assemble the package for review | `08-package/`, including document copies in `08-package/filing-copies/` |
| 8 | Review with a second AI | `07-red-team/` |

When a step needs your input, answer in the app. Your answers are saved in `00-intake/inventor-answers.md` before the step continues.

At step 3, a recommendation to continue gets an independent second opinion from the other AI before drafting starts. It runs its own searches and checks whether filing is worth the money. Allow about 20 to 45 minutes when a second opinion is needed. If the AIs disagree, read both reports and reply "continue" to draft anyway, "stop" to finish with a not-worth-filing result, or answer the concerns raised. The first AI weighs your reply and rewrites its recommendation; the second opinion does not run again for that reply. If the other AI is unavailable, set it up in Setup or reply "continue" to proceed on one AI's recommendation. The app records that choice. Drafting stays locked until step 3 is resolved, and changing or removing the second opinion requires step 3 to run again.

Each step builds on the previous result. Changing the idea or repeating an earlier step can require later steps to run again. The app shows the reason.

The AI chosen in step 4 writes steps 4 to 7. The other AI reviews the draft in step 8. If it finds required fixes, run step 6, then repeat steps 7 and 8.

## Results and files

**Finished: not worth filing** means the AI recommends stopping. Read its report for the evidence and alternatives.

**Ready for professional review** requires current results for every drafting step, the required automated checks, and a second AI review with no required fixes. This status is for human review.

Each invention has a folder of documents. The app stores your answers, step history, check results and run logs separately in its application data folder. Changes to checked files invalidate the relevant results.

Your chosen AI sends your answers and material it reads to Anthropic or OpenAI. API and search keys are encrypted using the operating system's secure storage and masked in app logs. Subscription runs use the AI tools' sign-in.

## How the code is laid out

- `src/workflow.js`: the nine steps, what each writes, and which step each builds on.
- `src/campaign.js`: decides step availability and readiness from the saved results and current files.
- `src/main.js`: runs steps and checks, handles Stop, and prevents overlapping work on an invention.
- `src/projects.js`, `src/safe-write.js`: the app's records (kept outside the invention folder) and careful file access inside it.
- `src/engines.js`, `src/gates.js`, `src/env.js`, `src/settings.js`: the AI tools, the app's own checks, tool detection, settings and keys.
- `ui/`: one file per screen (`steps.js`, `tabs.js`, `intake.js`, `setup.js`, `settings.js`, `help.js`), with `project.js` and `app.js` as the frame.

## Implementation details

See `CONTRACT.md` for the implementation requirements. Automated checks run through the patent tools. The app records which files each check covered and detects later changes.

Claude and Codex runs use their file-access restrictions. They can write in the invention folder and system temporary folders; added source material is read-only. Runs use the app's campaign instructions. See `src/engines.js` for the platform-specific setup.

## Recorded verification

These are the recorded results from November 12 and 13, 2026, not a fresh test of every build:

- **No-go path.** Claude (7 min) and Codex (11 min) independently searched a test invention and both reached a no-go citing the same 2025 publication; the app showed "Finished: not worth filing".
- **Go path, all nine steps.** A second test invention got a real GO. Claude wrote 26 claims, the description and ten drawings; the app's checks ran before and after step 6 (0 critical problems, claim references were checked); the package was assembled and passed the package check; Codex attacked it. The AI stopped to ask the inventor real questions five times (search, claims, description, package, fixes) and continued from the answers each time.
- **The fix loop.** The attack came back FAIL three times and the app said so each time: six must-fix findings, then two, then a new obviousness attack. The loop (step 6 fixes, step 7 reassembles, step 8 attacks) ran three full turns. The top status, "Ready for professional review", was not reached live, because the attacker never passed the draft. It has been reached only in a scratch-folder probe of the model.
- **Guards, probed live on the running app:** a second start on the same invention is refused; Stop during the app's own checks frees the invention; the writer's family is refused for the attack and the other family is refused for steps 4 to 7.

Probed against the real code earlier: forged records ignored, `RED TEAM: FAIL` with "PASS" in the body stays FAIL, symlink and `../` escapes refused, deleting a filing file invalidates its package check, a non-zero exit after a final result is an error, a printed API key is masked, navigation to an AI-written HTML file is refused, writes outside the folder are refused.

Windows, November 13 and 14: the installer runs without administrator rights, Setup installs the patent tools with graphics card support, and a test invention ran steps 0 to 3 to a no-go with Codex and Claude. Closing the app mid-step and reopening it recovers.

Windows, November 16 and 17: Update refuses while another program holds the patent tools, updates 0.2.0 to 0.3.0 in place with the rulebook unchanged, and rebuilds a Python 3.9 install on 3.12. A real invention ran through step 6.

Mac, November 17: Codex wrote steps 4 to 7 with Claude attacking at step 8, after File anyway, through three fix rounds. Stop while a step waits for the internet ends it within a second and frees the invention.

Mac, November 20, on an empty home folder with no Claude Code, Codex, Python, uv or patent tools: Setup installed Claude Code and Codex with their makers' installers, then the patent tools on their own Python 3.12, and built the rulebook (66,692 passages) in about 36 minutes, all from the app's buttons. A saved API key counts as ready, and Cancel ends a waiting sign-in.

Not yet exercised: the two API-key options with real keys, steps 7 and 8 on Windows, a computer with no Graphviz. Proven on a Mac on Nov 26 with EPO as the only search source: step 2 stops at once when patent search is off, and replying "ready" after signing in to the second AI reruns only the second opinion, leaving the first recommendation unchanged.
