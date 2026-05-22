# Safeguard JIT — End-User Guide

> **Audience:** Strata operators who use the Credentials page to
> create profiles and check out privileged-account passwords from
> OneIdentity Safeguard for Privileged Passwords (SPP).
>
> If you are an administrator wiring up the Safeguard integration
> itself (appliance URL, auth mode, A2A secrets, password caching),
> see [safeguard.md](./safeguard.md) instead.

---

## Contents

1. [What is Safeguard JIT?](#what-is-safeguard-jit)
2. [Before you begin](#before-you-begin)
3. [Step 1 — Sign in to Safeguard from Strata](#step-1--sign-in-to-safeguard-from-strata)
4. [Step 2 — Create a Safeguard credential profile](#step-2--create-a-safeguard-credential-profile)
5. [Step 3 — Bulk checkout for a planned change window](#step-3--bulk-checkout-for-a-planned-change-window)
6. [Step 4 — Check credentials back in when you're done](#step-4--check-credentials-back-in-when-youre-done)
7. [Understanding the status badges](#understanding-the-status-badges)
8. [Day-to-day session use](#day-to-day-session-use)
9. [Troubleshooting](#troubleshooting)

---

## What is Safeguard JIT?

Before v1.10.0, every credential profile in Strata carried a
password that was sealed by Vault and stored inside Strata's own
database. When you opened a session, Strata decrypted the password
and handed it to RDP / SSH.

From v1.10.0 onwards, you can instead create a profile of kind
**Safeguard**. This kind of profile **does not store a password**.
Instead it carries:

- the Safeguard **AccountID** for the privileged account, and
- the Safeguard **asset name** the account lives on.

When you (or Strata, on your behalf) open a session that uses such a
profile, Strata reaches into the Safeguard appliance, asks for the
password right then and there, hands it to RDP / SSH, and forgets
it (or remembers it for the duration of your shift, if your
administrator has enabled the optional password cache).

The benefits to you as an operator:

- You **never see**, **never copy**, and **never paste** the actual
  password. The Safeguard audit log shows you, by name, asking for
  the credential. Compliance is happy.
- Safeguard's own rotation policy stays in effect. You don't have
  to remember to clear stored passwords after a sensitive task.
- A single justification covers a whole list of credentials with
  **Bulk Checkout** — useful for change windows where you know
  you'll need ten servers in the next hour.

---

## Before you begin

You need:

- A **Safeguard user account** on the same appliance your Strata
  administrator has configured. Your Strata account doesn't need to
  match your Safeguard account — the integration uses your
  Safeguard identity for the actual checkout.
- The **Safeguard PowerShell module** installed on your desktop, if
  your administrator has selected per-user browser sign-in (the
  default). Install it from PowerShell Gallery:

  ```powershell
  Install-Module -Name SafeguardPS -Scope CurrentUser
  ```

- Permission in Safeguard to perform an **Access Request** for the
  target account(s).
- Your administrator should have told you:
  - the Safeguard appliance hostname (e.g. `spp.example.com`),
  - the IdP alias to use (e.g. `extf161`), and
  - whether the deployment uses per-user browser sign-in, A2A, or
    hybrid (this changes step 1).

Open Strata, sign in, and navigate to the **Credentials** page. If
your administrator has not yet enabled Safeguard JIT in the global
settings, the page will look exactly like it did before — that is
the kill switch in action, and your administrator needs to flip it
on before you can proceed.

---

## Step 1 — Sign in to Safeguard from Strata

> If your deployment uses **A2A only** (your administrator will
> have told you), skip this step entirely — Strata signs in to
> Safeguard automatically using its own credentials. Go straight
> to step 2.

The Credentials page has a tab strip near the top. Click **Request
Checkout**. The left-hand card on that tab is the **Safeguard
sign-in** card. If you have never signed in (or your last token has
expired), it shows a **Signed out** badge and a token input field.

In a separate PowerShell window, run:

```powershell
Connect-Safeguard `
    -Appliance spp.example.com `
    -Browser `
    -IdentityProvider extf161
```

(substitute your appliance and IdP alias). The Safeguard module
will open a browser tab against the appliance's federation
endpoint. Complete your normal corporate sign-in (MFA / smart card /
whatever your environment requires). When the browser tab confirms
the sign-in, switch back to PowerShell and run:

```powershell
(Get-SafeguardAccessToken)
```

That prints a long opaque string starting with `eyJ…`. Copy the
entire string, paste it into the **Token** field on the Strata
sign-in card, and click **Sign in**.

The card now shows a green **Signed in** badge with a countdown
("**14 min left**", etc.). The token is sealed by Vault and stored
in Strata's database under your user — no one else's checkout can
use your token.

> **Why the countdown?** Safeguard's RSTS tokens have a short
> lifetime (commonly 15 minutes). When the countdown reaches zero,
> the next checkout will fail with a clear "token expired" error —
> repeat this step to mint a fresh token. If your administrator
> has enabled **password caching**, this only affects new
> checkouts; previously-checked-out credentials remain usable for
> their full profile TTL.

---

## Step 2 — Create a Safeguard credential profile

A credential profile in Strata represents a single
"identity-on-target" — e.g. "domain admin on the prod AD forest", or
"oracle on the finance DB host". Each profile is reusable across
multiple connections.

To create a Safeguard-kind profile:

1. On the Credentials page, switch to the **Profiles** tab.
2. Click **New profile**.
3. Set **Kind** to **Safeguard**. (If you don't see Safeguard in
   the dropdown, your administrator has not yet enabled JIT — go
   back to your administrator before continuing.)
4. Fill in:
   - **Profile name** — a friendly label, e.g. `dom-admin
     (Safeguard)`.
   - **Safeguard AccountID** — the numeric id of the privileged
     account in Safeguard. Your administrator can give you this,
     or you can look it up in the Safeguard web UI: the
     **Privileged Accounts** view shows the id in the URL when you
     click into an account.
   - **Safeguard asset** — the asset display name. This is used
     for human-readable matching during preflight and audit; it
     should match what the appliance shows in the Asset column.
   - **TTL (hours)** — how long Strata will reuse a cached
     password for this profile before re-checking it out (only
     relevant if your administrator has enabled password caching).
     Pick something that matches your typical shift — 8 hours is a
     reasonable default for a working day.
5. Click **Save**.

The new profile lands in the Profiles list with a small **SG**
badge next to it (distinguishing it from local-password profiles).

To bind the profile to a connection: open **Connections** in the
sidebar, edit the connection, set **Credential profile** to the
new Safeguard profile, save. The next session against that
connection will resolve its credentials through the appliance.

---

## Step 3 — Bulk checkout for a planned change window

If you know you'll need credentials for several servers during a
patch window or change ticket, the **Bulk Checkout** card lets you
pre-fetch all of them in one signed-in burst.

1. Make sure you are signed in (step 1).
2. Switch to the **Request Checkout** tab. The right-hand card is
   the bulk-checkout card and lists every Safeguard-kind profile
   you own.
3. Type a **Justification** at the top of the card. **This field
   is mandatory** — the button stays disabled until you fill it
   in. Whatever you type here is sent verbatim as Safeguard's
   `ReasonComment` and is what the Safeguard reviewer / approver
   will see on every request. Use a meaningful, change-traceable
   value:

   > ✅ `CHG12345 — Q2 patch cycle for the prod web tier`
   >
   > ❌ `test` / `bulk` / `automation` (your reviewer will not
   > thank you)

4. Tick the checkbox next to each profile you want to pre-fetch
   (or click **Select all** for everything in the list).
5. Click **Checkout selected (N)**.

Strata iterates one profile at a time — typically a few hundred
milliseconds each, plus any retries against the appliance — and
updates each row in place as it completes. Successful rows show
the new **Active until …** badge with the moment the cache row
expires; failed rows show an inline red error with the full
Safeguard error body, so you know whether to retry the row
individually, re-sign-in, or escalate to your administrator.

Once a row is active, opening a session against any connection
bound to that profile reuses the cached password instantly — no
extra Safeguard round-trip, no fresh sign-in needed. This is the
mechanism that lets a long shift work without minute-by-minute
re-signing.

---

## Step 4 — Check credentials back in when you're done

When you finish the change window (or whenever you no longer need
the credentials), check them back in. This both:

- releases the access request on the Safeguard appliance (so the
  appliance can rotate the password if its policy says so), and
- expires the matching rows in Strata's local cache so they cannot
  be used inadvertently.

There are two ways:

- **One-click bulk check-in.** The bulk-checkout card shows a
  **Check in all (N)** button as long as you have any active
  cached credentials. Click it; the card iterates and reports the
  outcome per row.
- **Per-profile check-in.** Each active row in the card has its
  own **Check in** button.

After check-in, the matching row in the **Profiles** list flips
to the red **Expired — update required** pill. Opening a session
against a connection bound to that profile will trigger a fresh
JIT checkout (and, if caching is enabled, prompt for a fresh
justification).

> **Tip — don't leave credentials checked out at end of shift.**
> Even though caching extends the practical lifetime, both your
> appliance's audit policy and Strata's cleanest UX assume you
> return what you don't need. **Check in all (N)** is one click.

---

## Understanding the status badges

The Profiles list and the bulk-checkout card share a small badge
vocabulary:

| Badge                            | Meaning                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **SG**                           | This profile is Safeguard-kind (rather than local).                                                                                      |
| **Active — N min left**          | A cached password exists for you on this profile; the next session open will use it without contacting Safeguard.                        |
| **Checked-In**                   | The most recent checkout has been released. Next session open will trigger a fresh JIT checkout against Safeguard.                       |
| **Expired — update required**    | Either the cache row has aged past its TTL, or the credential was explicitly checked in. Same UX consequence as Checked-In.              |
| **Signed in — N min left**       | Your Safeguard sign-in token is present and not yet expired. Bulk checkout will work; per-session JIT checkout will work.                |
| **Signed out**                   | No valid Safeguard sign-in token for your user. Bulk checkout is disabled; per-session JIT checkout will fail with a clear error.        |

---

## Day-to-day session use

If your administrator has set up the integration so that every
session triggers a fresh JIT checkout (i.e. **password caching is
disabled**):

- Every time you open a session for a connection bound to a
  Safeguard profile, Strata silently reaches into the appliance
  and pulls the password. You don't have to do anything beyond
  being signed in (step 1).
- If you're not signed in, the session open returns a clear error
  telling you so — go back to the Credentials page and sign in.

If your administrator has enabled **password caching**:

- The first session after a checkout (bulk or single) is the same.
- Subsequent sessions within the profile's TTL reuse the cached
  password and don't contact Safeguard at all — so a Safeguard
  outage in the middle of your shift doesn't break in-flight work
  (only new checkouts).
- The cached credential is invalidated automatically at the TTL,
  and you'll need to either bulk-check-out again or open a session
  to trigger a fresh JIT checkout.

---

## Troubleshooting

### "Token expired" when I try to bulk-checkout

Your RSTS sign-in token has aged past its TTL (commonly 15
minutes). Re-run `Connect-Safeguard -Browser` and paste the new
token (step 1). If this is happening every few minutes during a
long shift, ask your administrator to enable **password caching**
so a cached credential survives the sign-in expiring.

### "Another request is already pending for this account"

This is Safeguard Code 90001. Strata's preflight tries to clear
this automatically, but if it surfaces it usually means a stale
request was in a state Strata couldn't reconcile cleanly. Sign in
to the Safeguard web UI directly, locate the stale request under
**My Requests**, and check it in or cancel it manually — then
retry the Strata checkout.

### "Pending password reset — please retry"

This is Safeguard Code 90010 — the appliance is rotating the
password right now. Strata waits up to ~10 s for the rotation to
finish before giving up; if you see this error it means the
rotation took longer than that. Retry the same operation; the
second attempt almost always succeeds.

### Bulk checkout shows one row in red but the others succeeded

Open the failing row's expanded error message and look at the
Safeguard code:

- **Code 90114** — your role doesn't have CheckOut permission on
  this account. Talk to your Safeguard administrator.
- **Code 70000 / 40400** — the Safeguard `AccountID` on the
  profile is wrong (account doesn't exist, or was removed from
  Safeguard). Edit the profile in step 2.
- Any other code — copy the full error text and send it to your
  Strata administrator with the timestamp.

### My session opens but RDP says "username or password is incorrect"

If you have **password caching disabled** and you're seeing this
on the first session right after a checkout, you probably hit the
brief 90001 race window. Click **Check in all** in the
bulk-checkout card, wait five seconds, and retry the session.

If you have **password caching enabled** and you're seeing this
in the middle of a shift, your cached credential is probably
stale because the Safeguard appliance rotated independently. Click
**Check in** on the affected row in the bulk-checkout card and
re-open the session — a fresh JIT checkout will run and pull the
new password.

### I can't see the Safeguard tab at all

Either:

- Your administrator hasn't enabled the integration globally
  (kill switch is off). Ask them to enable **Admin → Secrets &
  Security → Safeguard JIT**.
- Or you're on a version of Strata older than 1.10.0. Check the
  **About** dialog under **Help**.

---

## Related documentation

- [safeguard.md](./safeguard.md) — administrator / integrator
  implementation guide for the Safeguard integration.
- [api-reference.md](./api-reference.md#safeguard-jit-endpoints-v1100) —
  REST surface used by the SPA.
- [security.md](./security.md#safeguard-jit-credential-checkout-security-v1100) —
  threat model and at-rest protections.
- [architecture.md](./architecture.md#safeguard-jit-credential-checkout-v1100) —
  service-layer module breakdown and JIT checkout sequence.
