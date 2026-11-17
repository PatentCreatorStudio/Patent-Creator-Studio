# Patent Creator Studio: the contract

What the desktop app must be, written before the code so "was this the goal?" has a file for an answer.

## Goal

A private copy of Claude Patent Creator, shown in an Electron app that keeps an inventor's work organized and walks them through the patent process. The AI runs on whatever the person already pays for: their Claude Code subscription, their ChatGPT (Codex) subscription, or their own Anthropic or OpenAI API key. Do not rewrite the game: the campaign is the existing `patent-application-creator` skill and the existing MCP tools. The app picks what works for that goal and adapts proven methods from elsewhere.

## Must be true

1. **Four engines, one workflow.** Claude Code (subscription), Claude (Anthropic API key), Codex (ChatGPT subscription), Codex (OpenAI API key). Every phase runs on any of them with the same instructions and the same patent tools.
2. **The person's own tools run.** The app drives the CLIs the person installed and logged into. It never asks for, stores, or relays a Claude.ai or ChatGPT password or token. API keys are stored encrypted by the operating system keychain (Electron `safeStorage`) and passed only to the one child process that needs them.
3. **The campaign is the skill.** Phase instructions come from `skills/patent-application-creator/SKILL.md` in this repo, read at run time. The app adds organization, not a second legal method.
4. **One folder per invention.** Every artifact the AI writes lands in that invention's folder, in plain files the person can open without the app.
5. **The app checks the AI, the AI does not check itself.** Readiness checks (`check_package`, `review_patent_claims`, `review_specification`, `check_formalities`, search status) are called by the app directly against the patent-creator MCP server, not reported by the model.
6. **Readiness is never overstated.** The highest status the app can show is "Ready for a professional's review", and only when every deterministic gate passed on the current file contents. It never says "filing-ready", "patentable", or "good to go". A missing patent search key blocks the go/no-go decision, as the skill requires.
7. **A no-go is a finished result.** When the sweep kills the idea, the app presents the no-go report as the deliverable, with the evidence, not as an error. **The inventor may overrule it** (Rob, 2026-11-17: "It is as you said, so allow it."): File anyway at a step 3 no-go, after seeing the AI's reasons and confirming. The choice lives on step 3's record and is cleared when step 3 runs again or its report changes; it is written into the answers file; every later check and the second AI's review still run; and every status from then on says "against the AI's recommendation".
8. **The patent tools are the ones this app carries.** The app installs its own copy of Claude Patent Creator and checks the installed version against it every time it looks at the computer. An older copy is offered as an Update in Setup and nothing runs on it until then. Studio releases build only when every public Claude-Patent-Creator commit is merged in; a weekly workflow opens that merge.
9. **Plain English.** Every step says what it does for the inventor, what it costs (time; real money only where real money is spent, like a BigQuery search), and what the person must decide.
10. **The AI is the researcher.** Rob, 2026-11-17: "Why is it asking all these questions? Isn't it supposed to be the researcher?" and "The app shouldn't have asked the questions. It should have found the answers." A step finds facts itself and uses what it finds, citing the source; it never asks the inventor to confirm evidence it holds. A fact nothing can settle is written as a best-evidenced finding with what would settle it. A step stops for the inventor only when the next step is blocked by a decision that is theirs alone, or by a fact about the invention that only they know (how their device works, what they built). A draft gap of that kind is asked about, never turned into a no-go before the inventor has been asked.

## Must never happen

- A status shown that no check backs.
- A key written to a plain file or a log.
- A run that writes outside the invention's folder (the engine's working directory is the folder; Codex runs in `workspace-write`).
- An AI listed as inventor.

## What a failure looks like

- A phase that shows done while its artifact is missing.
- A gate result older than the file it checked (gates record the SHA-256 of what they read; an edit marks them stale).
- An engine that silently fails: every child process exit with a non-zero code or an error event reaches the screen in words.
- A step shown as done after the step it was built on was run again, or after the idea's description changed.
- A "ready" banner while any step is waiting on the inventor, or after a later step said the idea is not worth filing.
- The AI that wrote any part of the draft attacking it.
- Two things running on one invention at once.
- A check or AI step running on patent tools older than the copy the app carries.
