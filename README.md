# Salarn — Crypto Trading Platform

A full-featured crypto investment platform with copy trading, portfolio management, and admin controls. Built with React + Vite + Supabase.

---

## Stack

- **Frontend**: React 18, Vite 5, Tailwind CSS v4, Framer Motion
- **Auth & DB**: Supabase (PKCE auth flow, PostgreSQL + RLS)
- **Deployment**: Vercel (static SPA)

---

## Deploy to Vercel (Step-by-Step)

### 1. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** → paste and run the entire `SUPABASE_SCHEMA.sql` file
3. Go to **Authentication → URL Configuration**:
   - Set **Site URL** to your production domain (e.g. `https://salarn.vercel.app`)
   - Add to **Redirect URLs**: `https://salarn.vercel.app/auth/callback`
   - Also add your domain root: `https://salarn.vercel.app`
4. **If using custom SMTP** (e.g. Resend, SendGrid, Mailgun): go to **Auth → SMTP Settings**, enter credentials, then click **"Send Test Email"** to verify it works before deploying. A misconfigured SMTP is the #1 cause of the `error {}` signup bug.
5. **If using custom email templates**: after saving templates, test again with a new signup. The `error {}` error on second signup almost always means your SMTP is failing to send the confirmation email — not a code bug.

### 2. Environment Variables

Get these from Supabase → **Project Settings → API**:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your project URL (`https://xxxx.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Your `anon` public key |
| `VITE_APP_URL` | Your production domain (e.g. `https://salarn.vercel.app`) |

Add all three to **Vercel → Project Settings → Environment Variables**.

> **Important:** After adding env vars, you must redeploy for them to take effect.

### 3. Push to GitHub

Upload **only these files/folders** to your GitHub repo root:

```
src/
public/
index.html
package.json
vite.config.ts
tsconfig.json
vercel.json
components.json
SUPABASE_SCHEMA.sql
README.md
```

**Do NOT upload:**
- `node_modules/`
- `dist/`
- `.env` or `.env.local`
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` (Replit-specific)
- `.replit-artifact/`

### 4. Import to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project** → import your GitHub repo
2. Framework preset: **Vite** (auto-detected)
3. Add your 3 environment variables (from step 2 above)
4. Click **Deploy**

Vercel will run `npm ci && npm run build` using the `vercel.json` config.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_APP_URL=http://localhost:3000

# 3. Run dev server
npm run dev
```

---

## Making Yourself Admin

After your first signup, run this in **Supabase → SQL Editor**:

```sql
UPDATE public.users SET role = 'admin' WHERE email = 'your@email.com';
```

Then sign out and sign back in — you'll be redirected to `/admin`.

---

## Common Issues & Fixes

| Problem | Fix |
|---|---|
| Vercel build error `catalog:` | You uploaded the wrong `package.json`. Use the one from this project — it has real version numbers. |
| `error {}` on signup | Your Supabase SMTP is misconfigured or the email couldn't be delivered. Go to Supabase → Auth → SMTP Settings, enter valid credentials, and click **Send Test Email**. If the test passes but signup still fails, temporarily disable **"Enable Custom SMTP"** and re-test. |
| First signup works, second signup fails | Same SMTP issue. Every signup triggers an email. Use Supabase's built-in email service (no SMTP config needed) for testing, or verify your SMTP credentials. |
| OTP verification fails | Ensure the `txns_update_own_otp` RLS policy exists. Re-run `SUPABASE_SCHEMA.sql` to restore it. |
| Admin redirect not working after role change | Sign out and back in — the role is cached in the session. |
| Auth callback PKCE error | Confirmation links must be opened in the **same browser** where you signed up (PKCE stores a verifier in localStorage). |
| User stuck on loading screen | `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing or wrong in Vercel env vars. Redeploy after adding them. |
| Admin can't add/edit/delete traders | Re-run `SUPABASE_SCHEMA.sql` — the `traders_admin_all` policy was added in v4. |
| Balance goes negative | Fixed in v4 — the `api.balances.update` function now clamps to 0. |
| Copy trade stop button fails | Fixed in v4 — `copyTrades.stop` now includes `updated_at`. |

---

## OTP Withdrawal Flow

1. User submits a withdrawal request → status: `pending`
2. Admin approves in **Admin → Transactions** → balance reserved, OTP generated and shown to admin
3. Admin shares the 6-digit OTP with the user (via email/phone/message)
4. User goes to **Transactions** page → clicks "Enter OTP" → enters the code → status becomes `completed`
5. Funds are sent to the user's wallet address

The `txns_update_own_otp` RLS policy is what allows users to verify their own OTP without needing admin privileges.

---

## Admin Panel Features

- **Manage Users** — view all users, promote/demote to admin
- **Manage Cryptos** — add, edit, delete tradeable coins
- **Manage Traders** — create and approve copy traders visible to users
- **Transactions** — approve/reject deposits & withdrawals, generate OTP codes for withdrawals
- **Platform Settings** — set deposit wallet addresses (BTC, ETH, USDT, BNB, etc.)

---

## File Structure

```
src/
├── lib/
│   ├── auth.tsx          — Auth context (signup, signin, signout, role fetch, race-free)
│   ├── supabase.ts       — Supabase client + TypeScript types
│   ├── api.ts            — All Supabase data operations (safe, guarded)
│   └── marketData.ts     — Real-time crypto price fetching via CoinGecko
├── pages/
│   ├── Auth.tsx          — Sign in / Sign up / Forgot password
│   ├── AuthCallback.tsx  — PKCE code exchange + redirect (admin role aware)
│   ├── ResetPassword.tsx — Password reset form (session-verified)
│   ├── Dashboard.tsx
│   ├── Portfolio.tsx
│   ├── Trade.tsx
│   ├── CopyTrading.tsx
│   ├── Transactions.tsx  — Deposits, withdrawals + OTP verification
│   ├── Settings.tsx
│   └── admin/            — Admin-only pages (guarded by AdminRoute)
├── components/
│   ├── layout/AppLayout.tsx
│   ├── ProtectedRoute.tsx — Redirects to /auth if not logged in
│   └── AdminRoute.tsx     — Redirects to /dashboard if not admin
└── index.css             — Tailwind v4 + custom design tokens
SUPABASE_SCHEMA.sql       — Run once in Supabase SQL Editor (v4)
vercel.json               — Vercel deployment config
```
