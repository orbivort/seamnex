# Code of conduct

**Applies to:** every project space — issues, pull requests, reviews, discussions, commit messages and
documentation · **Owner:** platform maintainers · **Last reviewed:** 2026-11-06 · **Version:** 1.0

Seamnex should be a safe and productive place to contribute for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender identity and expression,
experience, education, socio-economic status, nationality, appearance, race, religion, or sexual
identity and orientation. This document states the behaviour we expect, what falls outside it, and
what happens when it is broken.

## Expected behaviour

- **Critique the work, not the person.** "This returns 500 on a second job" is a review comment; "you
  clearly don't understand the job model" is not.
- **Assume competence and good faith.** Ask what constraint produced an odd-looking decision before
  assuming there was none — the reason is usually in an ADR or a comment.
- **Give reasons, not verdicts.** Name the requirement, the failure or the measurement behind a
  requested change. "I don't like it" is a preference; "this breaks the 409 on a concurrent start" is
  a review.
- **Be precise about evidence.** Do not claim a test, benchmark or verification you did not run.
  "Untested — I could not start the stack" is useful; "works" without a check is not.
- **Own your mistakes.** Say so early, revert or fix, and explain what happened.
- **Keep discussions on topic and in one place.** A bug report is not a design debate; a design debate
  is not six threads in one pull request.
- **Protect privacy.** Never publish personal information, private correspondence, credentials,
  tokens, customer data or the contents of a private security report. Reproduce against test data and
  redact logs and screenshots.
- **Follow the documented process.** [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md)
  give a disagreement a route that is not escalation; security issues are reported privately, never
  as a public issue.

## Unacceptable behaviour

Not tolerated in any project space:

- **Harassment and intimidation** — sustained disruption, deliberate provocation, following someone
  across threads, or contact after a request to stop.
- **Personal attacks** — insults, belittling, mockery of ability or identity, or comments designed to
  make someone feel unwelcome.
- **Discrimination** — anything demeaning a person or group on the characteristics listed above,
  including "jokes" that rely on them.
- **Sexualised content or attention** of any kind.
- **Threats and incitement** — threats of violence, encouragement of self-harm, organising harm.
- **Doxxing** — publishing or threatening to publish private information without consent.
- **Exposing secrets or personal data** — credentials, session cookies, private keys, customer records
  or an undisclosed vulnerability in a public thread.
- **Bad-faith contribution** — code you have no right to submit, removed licence notices, a dependency
  added to exfiltrate data, or a change whose purpose differs from its description.
- **Sabotaging review** — force-pushing to hide a reviewed diff, editing another person's commits,
  closing an issue without a reason, reopening a settled decision without new evidence.
- **Spam and self-promotion.**
- **Retaliation** against a reporter, a witness, or someone who declines to take part in unacceptable
  behaviour.

Impact and pattern decide whether behaviour was unacceptable, not intent: "it was a joke" or "that is
how I review" does not make a comment acceptable.

## Scope

Covers project-operated spaces (issues, pull requests, reviews, commit messages, discussions, wikis,
documentation), spaces where someone represents the project, and private communication about project
work, including security and conduct reports. It applies to maintainers, contributors, reviewers and
anyone interacting with the project, with or without commit access, for the duration of their
participation. Conduct outside these spaces is in scope only where it seriously affects a community
member's safety or their ability to participate.

## Reporting a concern

If something has gone wrong, ask a maintainer to look at it privately. You do not need to be certain it
was a violation, you do not need proof, and you do not need to write a formal report — a short message
is enough, and we would rather hear about it once too often than lose a contributor over it.

The project has no dedicated conduct mailbox, so a report reaches us through GitHub. Pick whichever
channel feels comfortable — all three are equally valid.

1. **Private report to the maintainers** (default). Open the repository's **Security** tab, then
   **Advisories** → **Report a vulnerability**, and start the title with `conduct:` so it is not
   triaged as a vulnerability. Only you and the maintainers can read the thread, and it leaves a
   written record that survives a maintainer change.
2. **Direct message to a maintainer.** Send a GitHub message to any maintainer — one of the people
   with write access, listed on the repository's **People** page. Good for a conversation, or when the
   report concerns the advisory route itself.
3. **Ask for a private route in public.** Open an issue that says only that you need to raise a
   concern privately — no names, no details, no context. A maintainer replies with a private channel
   and locks the issue. Use this when the other channels are not available to you, for example
   because the report concerns every maintainer you can reach.

If a channel above is unavailable, the others still work. If the report concerns a maintainer, say so:
that person is excluded from handling it and it goes to another maintainer.

**Security vulnerabilities are not conduct concerns.** Follow [`SECURITY.md`](SECURITY.md) instead,
which covers private vulnerability reporting, the response targets and disclosure; a vulnerability
report needs reproduction steps, the affected version or commit, and the impact you demonstrated.

### What to include

None of this is mandatory, and a missing point is never a reason to close a report — we will ask.

- **What happened** — the behaviour, in your own words, and whether it is still going on.
- **Where and when** — the issue, pull request, review, discussion, chat or event, with links.
- **Who was involved** — GitHub handles of the people concerned and of anyone else affected.
- **Evidence** — screenshots, quotes or log excerpts, with personal data, credentials and uninvolved
  third parties redacted.
- **Impact** — who was affected and how: made to feel unwelcome, blocked from contributing, put at
  risk.
- **What you want** — an apology, a behaviour to stop, a decision reviewed, or simply a record. "I
  don't know" is a valid answer.
- **A safe way to reply** — if the account you report from is not the one you want us to use.

### What happens next

| Stage                                           | Target                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Acknowledgement, naming the handling maintainer | Within **3 business days**                                                |
| Assessment and next steps                       | Within **10 business days** of acknowledgement                            |
| Resolution or a revised timeline                | Within **30 days** of acknowledgement where the matter is straightforward |
| Status updates while the report is open         | At least every **10 business days**                                       |

1. **Assessment.** The handling maintainer reads the report, may ask follow-up questions, and checks
   what happened with the people involved. Asking questions is not disbelief.
2. **Decision.** The response follows the tiers in [Enforcement](#enforcement).
3. **Outcome.** You are told what was decided, in as much detail as confidentiality allows. If we
   conclude this code was not broken, we say so, and why.
4. **Appeal.** Within **14 days**, on the same private channel — see [Appeals](#appeals).

**Confidential by default.** A report is shared only with the maintainers who need it to assess and
act. The reported person is not told who reported, except where acting on the report requires it — and
we tell you before that happens. Your handle and the content of the report are never published.
Records are kept only as long as needed to handle the matter and recognise a pattern.

**Anonymous reports** are accepted and assessed; they are simply harder to act on, because we cannot
ask follow-up questions.

**Good faith is protected.** Reporting carries no consequence, even if we find no violation.
Retaliation against a reporter or a witness is itself a violation, and a knowingly false report made to
harm someone is one too.

Do not post the details of a conduct concern in an issue, pull request or discussion, and do not raise
it with the person concerned before reporting it. If the concern is about a public thread, report it
privately and ask for the thread to be paused — a maintainer may lock it while the report is assessed.

## Enforcement

Maintainers clarify and enforce these standards, and may remove, edit or reject material that does
not comply, stating the reason unless that would expose a reporter. Maintainers who do not enforce
this code in good faith face consequences decided by the other maintainers.

The response follows the impact on the community and the pattern of behaviour, not how upset anyone
sounds. A single severe incident may skip a tier.

| Tier             | Applies to                                                                                          | Consequence                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Correction    | A single minor incident — a sharp comment, an assumption stated as fact, an acknowledged lapse      | A private written note explaining what was inappropriate and why; a public clarification may be requested. Not a ban, and not held against the person indefinitely.                                                                                                     |
| 2. Warning       | A violation, or incidents after a correction, or with clear impact                                  | A formal written warning naming the behaviour, the expectation and the consequence of repetition. May include limited interaction — no unsolicited contact with a specific person, or comments only through a maintainer. Continued behaviour leads to a temporary ban. |
| 3. Temporary ban | A serious violation, or a pattern that persisted after a warning                                    | A ban from all project spaces for a stated period, typically 30–180 days, covering contact with those involved unless explicitly permitted. The conditions for return are stated in writing; violating the ban leads to a permanent ban.                                |
| 4. Permanent ban | Repeated violations, a severe incident (harassment, a threat, doxxing), or a violated temporary ban | A permanent ban from all project spaces. Merged contributions stay unless they themselves violate this code or the licence; the decision and its reason are recorded.                                                                                                   |

**Not enforcement.** Closing a stale pull request, declining a proposal on technical grounds,
requesting changes in review or refusing an unreviewed merge are ordinary project decisions. If you
believe one was made for a reason covered by this code rather than a technical one, that is what a
report is for.

## Appeals

Reply on the same private channel within **14 days** with the reason. A maintainer who did not make the
decision and, where possible, was not involved in the report reviews it and confirms, reduces or
withdraws it; the outcome is final. An appeal does not re-argue the technical dispute and does not
suspend the action, except a temporary ban where the appeal is clearly well-founded.

## Changes to this document

The version and review date at the top identify the current text; the file history is the
authoritative record of what changed. The document is reviewed at least once every 12 months.

Reports are handled under the version in force when the behaviour occurred: a revision that
strengthens protections for reporters applies to open matters, and no revision weakens the handling of
a matter already under way. Where this document conflicts with applicable law, the law prevails.

## Attribution

Adapted from the [Contributor Covenant](https://www.contributor-covenant.org), version 2.1
(<https://www.contributor-covenant.org/version/2/1/code_of_conduct.html>), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The four-tier structure follows it; the
reporting targets, appeal window, scope and confidentiality commitments are specific to this project.
