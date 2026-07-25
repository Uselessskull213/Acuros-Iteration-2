# Acuros Unity — Build Plan & Handoff Brief

> **How to use this document.** You are starting Acuros Unity in a new, empty repository.
> Read this whole file before writing any code. It is the complete brief: product context,
> locked decisions, data model, security requirements, module scope, and the CI gates that
> define "done." Section 11 inlines the code worth porting from a sibling project
> (Acuros Health) so this repo needs no access to it.
>
> Section 10 lists questions to ask the user before starting. Ask them first.

---

## 1. Product context

Schools run on a pile of disconnected tools: Google Classroom for coursework, a separate
gradebook, Edvance or a board portal for course selection, Xello for pathway planning, a
one-off awards site, and a news page nobody updates. Each has its own login, its own notion
of "who is a teacher," and its own copy of student data. Students lose track of what's due;
teachers re-enter the same roster four times; administrators cannot answer "is this student
on track to graduate" without opening three systems.

**Acuros Unity** is one system for all of it — coursework and grades, course selection and
graduation pathways, school news, and awards — with a single roster-backed identity and a
single permission model.

Two things differentiate it, and both are load-bearing:

1. **Security infrastructure is the product, not a feature.** The data is minors' education
   records. A permission bug is a reportable privacy breach, and school boards will not sign
   until they have seen tenancy isolation, an audit trail, and a privacy impact assessment.
   Authorization, auditing, and data residency ship in Phase 0, before any feature code.
2. **AI-operated support.** A user reporting a broken page gets it triaged, reproduced, and
   fixed by an agent pipeline that opens a reviewed PR the same day — instead of filing a
   ticket into a queue.

Acuros Health is a **separate, unrelated product** with its own patient data, its own repo,
and its own Supabase project. Unity shares no infrastructure with it. The only relationship
is that a few well-tested helpers are worth copying (Section 11).

---

## 2. Locked decisions

These were decided with the product owner. Do not relitigate them without asking.

| Decision | Choice |
|---|---|
| Codebase | Standalone repo `acuros-unity`, its own Supabase project(s), its own Vercel project. Zero shared infrastructure with Acuros Health. |
| Stack | Next.js App Router, full React app, TypeScript strict. Cookie-based Supabase SSR auth. |
| Phase 1 scope | All four modules: classroom core, course selection & pathways, news & calendar, awards & extracurriculars. |
| AI triage autonomy | Agent triages, reproduces, and opens a PR with tests. A human reviews and merges. **No autonomous deploys.** |
| Compliance | Both jurisdictions — design to the stricter union of Ontario/Canada (MFIPPA, PIPEDA) and US (FERPA, COPPA, SOPIPA). Region is per-tenant configuration, never hardcoded. |
| Identity | Both — Google Workspace / Microsoft Entra SSO with roster sync where a board has it, join-code self-serve for small schools and pilots. **The roster is authoritative wherever it exists.** |

### Scope note, stated honestly

All four modules in Phase 1 is a large first release — three of them are each a product on
their own. The sequencing below ships the classroom core first, because its
course/section/enrollment model is what the other three read from, and makes each
subsequent module independently shippable. If the timeline slips, cut from the back (awards,
then news) rather than descoping the core or the Phase 0 security work.

---

## 3. Stack and repository layout

```
acuros-unity/
  app/                      Next.js App Router
    (marketing)/            public site
    (auth)/                 sign-in, SSO callback, join-by-code
    (app)/                  authenticated shell
      student/  teacher/  guardian/  admin/
    api/                    route handlers (webhooks, SSO callback, roster sync, exports)
  lib/
    auth/                   session, RBAC evaluation (can.ts), step-up auth
    db/                     typed Supabase clients (server / browser / admin)
    policy/                 per-region compliance config (retention, consent, residency)
    audit/                  audit + disclosure logging
    rate-limit.ts           see Section 11
    sanitize.ts             see Section 11
  supabase/
    migrations/             ordered, checked-in SQL
    tests/                  pgTAP RLS test suite
    seed/                   synthetic-only fixtures (never real student data)
  agents/                   AI triage pipeline (Section 9)
  e2e/                      Playwright, per-role journeys
```

**Versions.** Next.js (App Router) with React 19, TypeScript in `strict` mode,
`@supabase/supabase-js` v2 + `@supabase/ssr`. Vitest for units, Playwright for E2E, pgTAP
for database policy tests.

**Rendering.** Server Components by default. Client Components only where interaction
demands it — the gradebook grid, the submission editor, the drag-and-drop course planner.
Mutations go through Server Actions or route handlers; **never a direct authenticated-client
write from the browser into a sensitive table.** RLS is the last line of defence, not the
only one.

**Auth flow.** `@supabase/ssr` with httpOnly, `Secure`, `SameSite=Lax` cookies. Middleware
refreshes the session and enforces an authenticated, role-appropriate check on every
`(app)` route. No route is public by omission — the middleware matcher is an **allowlist**
of public paths.

**Multi-region.** A `districts` row pins a region (`ca-central-1` / `us-east-1`). Each
region gets its own Supabase project and Vercel region; a routing layer resolves the
tenant's region at sign-in and pins the session to it. Schema is identical across regions
and applied from the same migration set. Cross-region reads are structurally impossible
because the data lives in different databases.

---

## 4. Phase 0 — Foundations (build this first, no user-facing features)

Nothing in Section 7 starts until this is done and the RLS test suite is green with real
negative assertions passing.

1. Repo scaffold, TypeScript strict, ESLint, Prettier, CI skeleton.
2. Supabase project(s) created; migrations tooling; `supabase db reset` reproducible from
   checked-in SQL alone.
3. Core tenancy + identity tables: `districts`, `schools`, `terms`, `profiles`,
   `role_assignments`, `guardian_links` (Section 5).
4. `lib/auth/can.ts` — the single authorization entry point (Section 6.1).
5. Cookie session + middleware route protection.
6. pgTAP harness plus its first negative tests, wired into CI as a blocking gate.
7. `audit_log` and `disclosure_log` with insert-only grants; `lib/audit/`.
8. `lib/policy/` region + compliance profile layer.
9. Synthetic seed generator (`supabase/seed/`) — a fake school with realistic shape.
10. Security headers, CSP with nonces, secret-leak CI check.

---

## 5. Data model

All tables `ENABLE ROW LEVEL SECURITY`, with **no permissive default policy**.

### Tenancy and identity

```
districts(id, name, region, policy_profile, sso_config, retention_profile)
schools(id, district_id, name, panel)              -- elementary/secondary
terms(id, school_id, name, starts_on, ends_on, is_current)

profiles(id -> auth.users, district_id, display_name, preferred_name,
         directory_opt_out, locale, created_at)    -- NO role column

role_assignments(id, user_id, role, scope_type, scope_id, source, expires_at)
  role       ∈ student | teacher | guardian | counsellor | office | school_admin
             | district_admin | support
  scope_type ∈ district | school | section
  source     ∈ roster | sso_claim | invite | manual   -- provenance, for audit

guardian_links(id, guardian_id, student_id, relationship, rights[], verified_at, verified_by)
  rights ∈ view_grades | view_attendance | approve_course_selection | receive_digests
```

### Classroom core

```
courses(id, school_id, code, title, credit_value, grade_level, description)
course_sections(id, course_id, term_id, section_code, room, period)
section_staff(section_id, user_id, staff_role)     -- teacher | co_teacher | ta
enrollments(id, section_id, student_id, status, enrolled_on, dropped_on)

assignment_categories(id, section_id, name, weight)
assignments(id, section_id, title, description_html, category_id, points_possible,
            assigned_at, due_at, published_at, allow_late, visibility)
submissions(id, assignment_id, student_id, submitted_at, state, body_html, late)
submission_files(id, submission_id, storage_path, filename, bytes, scan_state)
grades(id, assignment_id, student_id, score, is_excused, is_missing,
       graded_by, graded_at, published_at, comment)
grade_history(id, grade_id, old_score, new_score, changed_by, changed_at, reason)
```

### Course selection and pathways

```
catalog_offerings(id, school_id, course_id, term_id, seats, selection_window_id)
prerequisites(course_id, requires_course_id, min_grade, kind)   -- kind: hard | advisory
selection_windows(id, school_id, opens_at, closes_at, grade_levels[])
course_selections(id, student_id, window_id, offering_id, rank, state)
  state ∈ draft | submitted | counsellor_approved | guardian_approved | rejected | placed
graduation_requirements(id, district_id, name, rule)            -- JSONB rule spec
credit_ledger(id, student_id, course_id, credit_value, earned_on, source)
pathway_plans(id, student_id, target, plan)                     -- multi-year JSONB
```

### News and calendar

```
announcements(id, scope_type, scope_id, author_id, title, body_html,
              publish_at, expires_at, audiences[], pinned, state)
calendar_events(id, scope_type, scope_id, title, starts_at, ends_at, all_day, location)
digest_subscriptions(user_id, channel, cadence)
```

### Awards and extracurriculars

```
awards(id, school_id, title, description_html, criteria, value, opens_at, closes_at)
award_eligibility_rules(award_id, rule)             -- JSONB, evaluated server-side
award_applications(id, award_id, student_id, state, submitted_at, answers)
award_reviews(id, application_id, reviewer_id, score, notes, submitted_at)
activities(id, school_id, name, kind, supervisor_id)
activity_participation(id, activity_id, student_id, role, hours, verified_by, verified_at)
```

### Compliance and operations

```
audit_log(id, actor_id, action, subject_type, subject_id, scope_id,
          ip_hash, user_agent_hash, metadata, at)   -- append-only, insert-only grant
disclosure_log(id, student_id, disclosed_to, purpose, fields[], at)  -- FERPA §99.32
consents(id, subject_id, consent_type, granted_by, granted_at, revoked_at)
issue_reports(...)                                  -- see Section 9
roster_sync_runs(id, district_id, source, started_at, finished_at, stats, errors)
```

### Modelling choices that matter

- **Scoped RBAC, not a role column.** Every authorization question is "does this user hold
  role R over scope S, or an ancestor of S." A single `profiles.role` text column cannot
  express "teacher of section A, department head at school B, nothing at school C," and it
  is extremely expensive to retrofit. Get this right on day one.
- **Grades are append-only in effect.** `grade_history` records every change with actor and
  reason. Grade disputes are real and the audit trail is the answer to them.
- **Publish gates are RLS, not UI.** `assignments.published_at` and `grades.published_at`
  are separate from creation. Teachers draft in private; students see nothing until publish.
  Enforce this in the row-level policy — a UI filter is not enforcement.
- **Guardian rights are explicit and per-right**, never implied by the relationship. This is
  what handles custody arrangements and the age-of-majority transition (a rule flips a
  student's record to student-controlled at the district's configured age).
- **`directory_opt_out`** implements FERPA directory-information suppression and its
  Ontario equivalent. Every listing query respects it.

---

## 6. Security infrastructure

Over-invest here. Ordered by how much damage a mistake causes.

**6.1 Authorization evaluated server-side, twice.**
`lib/auth/can.ts` exposes `can(actor, action, resource)` — the single place any permission
question is answered in application code. RLS independently enforces the same rules in the
database. A feature is not done until both agree, and the pgTAP suite proves the database
half holds even if the application layer is bypassed entirely.

**6.2 Deny-by-default RLS with a proving test suite.**
Every table starts with RLS on and no policy. Policies are added narrowly, per role. A
pgTAP suite in `supabase/tests/` runs in CI and **fails the build** if:
- any table in `public` lacks RLS;
- any policy grants to `anon` unintentionally;
- any canonical negative case passes — student reads another student's grade, student reads
  an unpublished grade or assignment, teacher reads a section they don't staff, guardian
  reads an unlinked student or a right they weren't granted, any user reads across
  districts.

**A migration that adds a table without a corresponding RLS test does not merge.** Wire this
as a CI check, not a code-review convention.

**6.3 Helper functions, written carefully.**
Scope resolution (`current_user_school_ids()`, `has_role_over(role, scope_type, scope_id)`)
lives in `SECURITY DEFINER` functions, marked `STABLE`, with `SET search_path = public,
pg_temp`, and `REVOKE EXECUTE FROM anon, authenticated` wherever they are trigger-only.
Call them as `(select has_role_over(...))` inside policies so Postgres caches per-statement
instead of re-evaluating per row — this is a real performance cliff on gradebook queries,
not a micro-optimization.

**6.4 Roster is authoritative; escalation is structurally blocked.**
Where a roster sync exists, `role_assignments` rows with `source = 'roster'` are written
only by the sync service under the service-role key. A `guard_role_assignments` BEFORE
trigger rejects any INSERT/UPDATE from `anon`/`authenticated` that grants a staff role or
writes a roster-sourced row. Join-code self-serve can only ever mint `student` or `guardian`
with `source = 'invite'`; staff roles require approval by an existing `school_admin`,
recorded in the audit log. **A student must never be able to self-declare as a teacher.**

**6.5 MFA and step-up auth.**
TOTP/WebAuthn required for `teacher` and above. Step-up re-authentication (fresh factor
within 5 minutes) required for: publishing final grades, bulk export of student data,
changing another user's role assignments, and district settings. Enforced server-side.

**6.6 Audit everything that touches a student record.**
Append-only `audit_log` — insert-only grant, no UPDATE or DELETE to any application role.
Separately, `disclosure_log` records non-school-official disclosures for the FERPA
accounting requirement. Give administrators a per-student "who accessed this record" view;
it is a procurement selling point, not just a control.

**6.7 Transport and content security.**
- CSP with a **per-request nonce**. No `'unsafe-inline'`, no `'unsafe-eval'`, no CDN script
  hosts. (The sibling Health project's CSP allows all three — do not copy that forward.)
- `frame-ancestors 'none'`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, HSTS with preload, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- All user-authored HTML through the sanitizer in Section 11, fail-closed.
- CSRF: Server Actions carry Next's built-in protection; any custom mutating route handler
  requires an origin check plus a double-submit token.

**6.8 File handling.**
Private Supabase Storage buckets, paths namespaced by section and submission. Access only
via short-lived signed URLs minted server-side **after** a `can()` check — never a public
bucket, never a client-constructed path. Uploads validated by extension *and* magic bytes,
size-capped, and gated behind an async malware scan (`scan_state`) before any download is
served.

**6.9 Secrets and key hygiene.**
The service-role key exists only in server runtime env. A CI check greps the built client
bundle for it and for any `SUPABASE_SERVICE_ROLE` reference outside `lib/db/admin.ts`.
Publishable/anon key in client code only. Documented quarterly rotation. **No secrets and no
hardcoded project refs in the repo** — read them from env, including on the client.

**6.10 Rate limiting and abuse.**
The limiter in Section 11 on: auth endpoints, join-code redemption (strict — codes are
guessable otherwise), submission upload, data export, and issue-report intake. Join codes
are high-entropy, per-school, revocable, expiring, and single-use where practical.

**6.11 Compliance, region-configurable.**
`lib/policy/` holds a per-district profile driving data residency, retention schedules with
**actual scheduled purge jobs**, consent requirements (COPPA under-13 gating, Ontario
consent norms), directory-information handling, and export/inspect/amend workflows. Every
student-facing record type gets a documented retention period with code behind it — not a
policy document alone.

Procurement deliverables to produce alongside the code: a PIA template, a data-flow diagram,
a subprocessor list, and a breach-response runbook. No advertising, no data sale, no
secondary use of student data — stated in the ToS and enforced by having no such code path.

**6.12 Independent verification.**
CI: `npm audit` + Dependabot, CodeQL, secret scanning, the pgTAP RLS suite, and a Playwright
role-isolation suite. Before the first real board goes live: a third-party penetration test.
SOC 2 Type I as a Phase 2 goal.

---

## 7. Modules

Sequenced. Each is independently shippable; later ones read the earlier data model.

### Module 1 — Classroom core *(build first)*

Courses, sections, staffing, enrollments.

- **Teacher:** create and publish assignments with categories and weights; submission queue;
  fast keyboard-navigable grading grid; publish grades.
- **Student:** dashboard of what's due; submit text and files; see published grades and
  feedback.
- **Guardian:** read-only grades and missing-work, subject to `guardian_links.rights`.
- Weighted-category and points-based grade calculation, configurable per section, computed
  **server-side** and unit-tested against known transcripts.
- Real-time updates via Supabase Realtime on the submission queue.

*Why first:* every other module reads `courses`, `enrollments`, `credit_ledger`, or section
scoping.

### Module 2 — Course selection & graduation pathways

Course catalog with prerequisites (hard and advisory). Selection windows opened per grade
level by administrators. Student picker with live prerequisite validation, seat counts, and
ranked alternates. Requirement engine evaluating `graduation_requirements` rules against
`credit_ledger` — "you need one more Group 2 arts credit" — with a multi-year planner.
Approval chain: student submits → counsellor reviews → guardian approves where required →
placement. Counsellor caseload view with at-risk flagging. Bulk placement export for the SIS.

### Module 3 — News, announcements & calendar

Scoped announcements (district / school / section / role audience) with the sanitizer on all
authored HTML, scheduled publish and expiry, pinning, translations. Unified calendar merging
events, assignment due dates, and term dates, with ICS subscription feeds. Email and push
digests honouring `digest_subscriptions`. Draft/review workflow for school-wide posts.

### Module 4 — Awards, scholarships & extracurriculars

Award catalog with **server-evaluated** eligibility rules — a student never sees an award
they cannot apply for, and eligibility is never computed client-side. Application forms with
save-as-draft and deadline enforcement. Staff adjudication with rubric scoring, optional
blind review, and conflict-of-interest recusal. Activity registry and verified
volunteer-hours tracking (feeds the Ontario community-involvement requirement). Award
history on the student record.

### Deferred to Phase 2

Attendance; behaviour and referrals; report-card generation and transcripts; staff↔guardian
messaging; SIS write-back (PowerSchool, Aspen, Trillium); OneRoster 1.2 and Clever
certification; LTI 1.3; mobile app; offline submission drafts; analytics dashboards;
end-to-end-encrypted counsellor notes.

---

## 8. Verification and CI gates

**Database.** `supabase db reset` from checked-in migrations, then the pgTAP suite. Minimum
passing negative assertions: cross-district read, cross-school read, student reads another
student's grade, student reads an unpublished grade or assignment, teacher reads a
non-staffed section, guardian reads an unlinked student or an ungranted right, and any
client-role attempt to insert a staff `role_assignment`. CI fails on any table lacking RLS.

**Application.** Vitest for the grade calculator (hand-computed transcripts as fixtures),
the graduation-requirement rule engine, the award eligibility evaluator, and `can()`.
Playwright journeys per role: teacher creates → student submits → teacher grades → guardian
sees only what they should; counsellor approves a selection; admin publishes an announcement
and audience scoping is verified; a student hitting a forbidden URL gets a 403 — not a blank
page, and not the data.

**Security.** CodeQL and secret scanning. A build-output grep asserting the service-role key
never appears in a client bundle. CSP validated to contain no `unsafe-*` directive.

**Manual smoke, per module.** Seed a synthetic school — 2 terms, 40 students, 8 teachers,
30 guardians, 15 sections — and walk each role through its primary journey in a preview
deployment.

---

## 9. AI-operated triage and repair

The support promise: a report filed in the morning is diagnosed, fixed, and sitting in a
reviewed PR the same day. **The agent never merges and never touches production.**

**Intake.** In-app report widget on every page, plus automatic capture from an error
boundary. Each report carries a redacted context bundle: route, role and scope *shape* (not
identity), request id, build SHA, browser, sanitized breadcrumbs. **A PII scrubber runs
before anything is stored** — no student names, no grades, no submission content, ever, in a
report body or a stack trace. Reports land in `issue_reports`, readable only by the support
role under RLS.

**Triage agent** (GitHub Actions, on new report and on a schedule). Deduplicates and clusters
against open issues, assigns severity, infers the owning module, enriches with matching
server logs and error-tracker events.

Severity ladder: **S1** (data exposure, or grades wrong) → page a human immediately, *no
agent autonomy*. **S2** blocking. **S3** degraded. **S4** cosmetic.

**Reproduction agent.** Spins up an ephemeral environment against a **synthetic-data branch
database** — never production, never a production clone. Drives Playwright to reproduce from
the breadcrumb trail. The failing test that reproduces the report becomes the regression
test. If it cannot reproduce, it says so and asks the reporter for specifics rather than
guessing.

**Fix agent.** Branches, writes the fix plus the regression test, runs the full suite
including the pgTAP RLS proofs, and opens a PR containing the original report, repro steps,
diagnosis, and diff. Labeled by severity and module.

**Guardrails — non-negotiable:**
- No production database credentials. No production deploy permissions. Ever.
- `CODEOWNERS` requires a human security reviewer on `supabase/migrations/`, `lib/auth/`,
  `lib/policy/`, middleware, and grade-calculation code. The agent may propose changes
  there; it cannot bypass review.
- Any PR touching an RLS policy or auth code carries a mandatory label and checklist.
- The agent cannot modify its own guardrails, the CI configuration, or `CODEOWNERS`.
- All agent activity is written to `audit_log` with the same rigour as human action.

**Loop closure.** The reporter is notified at triage, at PR, and at deploy. Weekly digest of
report volume, time-to-PR, and reproduction rate — the honest metric for whether the
same-day promise is actually being met.

---

## 10. Ask the user before starting

1. Supabase project(s) and region assignment — one project per region (`ca-central-1`,
   `us-east-1`) or start single-region and add the second later?
2. Launch pilot school or board. Its **actual** course catalog and graduation requirements
   should drive the rule-engine design rather than a hypothetical one.
3. Does the pilot have an SIS (PowerSchool / Aspen / Trillium)? Is read-only roster import
   enough for Phase 1, or is write-back expected?
4. Branding — does Unity share the Acuros mark and design language, or get its own?
5. Age of majority per district for the student-controlled-record transition (18 in Ontario;
   varies by US state).
6. Which SSO tenant(s) are available for testing Google Workspace and Entra ID?

---

## 11. Appendix — code worth porting from Acuros Health

These are battle-tested in the sibling project. Copy them into `lib/`, converted to
TypeScript. The notes on each explain what to change.

### 11.1 Rate limiter — Upstash Redis with in-memory fallback

Fixed-window (not sliding) via `EXPIRE ... NX`, so a burst can't keep extending the window.
Falls back to process memory when Upstash isn't configured — correct for local dev, and it
degrades rather than failing the request in production.

```js
const memoryBuckets = new Map();

function toSafeKeyPart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_');
}

async function runUpstashPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => 'unknown upstash error');
    throw new Error(`Upstash pipeline failed: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('Upstash returned unexpected response shape');
  return data.map((r) => r.result);
}

function checkMemoryRateLimit(key, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const bucket = memoryBuckets.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  fresh.push(now);
  memoryBuckets.set(key, fresh);
  return { allowed: fresh.length <= maxRequests, count: fresh.length };
}

export async function checkRateLimit({ route, identifier, maxRequests, windowSeconds }) {
  const key = `rl:${toSafeKeyPart(route)}:${toSafeKeyPart(identifier)}`;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      // INCR + EXPIRE atomically. EXPIRE NX only sets the TTL when the key has
      // no expiry — this keeps the window fixed rather than sliding per request.
      const [rawCount] = await runUpstashPipeline([
        ['INCR', key],
        ['EXPIRE', key, String(windowSeconds), 'NX'],
      ]);
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count < 1) {
        throw new Error(`Invalid Upstash INCR response: ${String(rawCount)}`);
      }
      return { allowed: count <= maxRequests, count };
    } catch (err) {
      console.error('[rate-limit] Upstash failed, using memory fallback:', err?.message || err);
    }
  }
  return checkMemoryRateLimit(key, maxRequests, windowSeconds);
}
```

### 11.2 HTML sanitizer — DOMPurify allowlist, fail-closed

For announcements and assignment descriptions. Note the three things that make it correct: a
real DOM-based allowlist rather than a regex denylist, `<style>` content scrubbing (DOMPurify
does not touch CSS inside style blocks), and **returning empty string on any exception** so
unsanitizable content is never served.

Adapt the config: Unity's rich text is a fragment, not a whole document, so drop
`WHOLE_DOCUMENT` and the `head`/`body`/`html` additions and tighten `ADD_TAGS` to the editor's
actual output.

```js
import DOMPurify from 'isomorphic-dompurify';

const CONFIG = {
  ADD_ATTR: ['rel', 'href', 'target'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'noscript', 'template'],
  FORBID_ATTR: ['http-equiv'],          // blocks <meta http-equiv="refresh">
  ALLOW_DATA_ATTR: false,
  // Drop unknown protocols entirely (javascript:, vbscript:, data:text/html…).
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
};

export function sanitizeRichText(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  let clean;
  try {
    clean = DOMPurify.sanitize(html, CONFIG);
  } catch (_e) {
    return '';                          // fail closed — never serve unsanitized HTML
  }
  if (typeof clean !== 'string') return '';

  // DOMPurify does not scrub CSS *inside* <style> blocks. Inert in modern
  // browsers, but neutralize the historically dangerous constructs anyway.
  return clean.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) =>
    open + css
      .replace(/expression\s*\(/gi, '(')
      .replace(/(?:javascript|vbscript)\s*:/gi, 'x:')
      .replace(/-moz-binding/gi, 'x-binding')
      .replace(/behavior\s*:/gi, 'x-behavior:')
      .replace(/@import\b[^;]*;?/gi, '') + close);
}
```

### 11.3 Admin (service-role) Supabase client

Cached singleton, `persistSession: false`. **Change from the original:** read exactly one env
var name (no fallback chain), and keep this file the *only* module in the repo that
references the service-role key so the CI grep in §6.9 has a single allowlisted path.

```ts
import { createClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
```

### 11.4 Postgres patterns to reuse

Three patterns from the Health project's account system, each learned from a production bug:

**Never put a `SECURITY DEFINER` function in a column `DEFAULT`.** A column default is
evaluated as the *inserting* role, which does not hold `EXECUTE` on the definer function —
every client insert then fails with "permission denied for function." Use a `BEFORE INSERT`
trigger instead; it runs as the function owner.

```sql
CREATE OR REPLACE FUNCTION public.set_join_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.join_code IS NULL OR NEW.join_code = '' THEN
    NEW.join_code := public.generate_join_code();
  END IF;
  RETURN NEW;
END;
$$;
```

**A privilege guard trigger, so clients cannot self-escalate even if a policy is wrong.**
This is defence in depth behind RLS — adapt it to `role_assignments` per §6.4.

```sql
CREATE OR REPLACE FUNCTION public.guard_role_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF auth.role() IN ('anon','authenticated') THEN
    IF NEW.source <> 'invite' THEN
      RAISE EXCEPTION 'role assignments of source % are service-managed', NEW.source;
    END IF;
    IF NEW.role NOT IN ('student','guardian') THEN
      RAISE EXCEPTION 'staff roles cannot be self-assigned';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
```

**Revoke `EXECUTE` on every trigger-only function.** Triggers fire regardless of caller
`EXECUTE`, so leaving the grant in place needlessly exposes them as callable RPCs.

```sql
REVOKE EXECUTE ON FUNCTION public.guard_role_assignments() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_join_code()          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_join_code()     FROM anon, authenticated;
```

**One more, subtle:** when a `NOT NULL` boolean column is populated from an `IN` expression
over possibly-NULL metadata, wrap it in `COALESCE`. `NULL IN ('a','b')` is `NULL`, not
`false`, and the insert fails. In Health this broke every OAuth signup, because OAuth
providers carry no role metadata.

### 11.5 Anti-patterns — present in Acuros Health, do not carry forward

| Anti-pattern | Why it's wrong here |
|---|---|
| Session tokens in `localStorage` | Any XSS becomes full account takeover. Use `@supabase/ssr` httpOnly cookies. Health's own auth file documents at length how much pain its storage layer caused. |
| A single `profiles.role` text column | Cannot express scoped or multiple roles. See §5. |
| CSP with `'unsafe-inline'`, `'unsafe-eval'`, and CDN script hosts | Defeats the main purpose of having a CSP. Use nonces. |
| Hardcoded project ref and anon key in a committed client file | Makes key rotation a multi-file edit and leaks tenancy details. Read from env. |
| Hand-written static HTML app pages | Fine for a nine-page marketing site; unworkable for a gradebook. |
