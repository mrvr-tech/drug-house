# Production Deployment Guide — Pharmacy Store Management System

This document outlines the step-by-step production deployment procedure for the **Pharmacy Store Management System** (Siddheshwar Drug House).

---

## 1. Architecture Overview

```
                          ┌────────────────────────┐
                          │   Vercel / Frontend    │
                          │ (Static HTML / CSS / JS)│
                          └───────────┬────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
    ┌──────────────────────┐                     ┌──────────────────────┐
    │  Supabase Database   │                     │ Supabase Edge Funcs  │
    │  (PostgreSQL + RLS)  │                     │  (admin-management)  │
    └──────────────────────┘                     └──────────────────────┘
```

- **Frontend**: Pure modern HTML5 / Vanilla CSS / JavaScript client deployed on Vercel or any static host.
- **Backend**: Supabase Cloud PostgreSQL with Row Level Security (RLS) & Stored Procedures (RPCs).
- **Administrative Logic**: Supabase Edge Function (`admin-management`) handling privileged user & lab administration.

---

## 2. Prerequisites

1. **GitHub Repository**: Connected to your GitHub account (`mrvr-tech/parmacy-store`).
2. **Supabase Project**: Active project with database schema, RLS policies, and RPCs configured.
3. **Vercel Account**: Linked to the GitHub repository for continuous automated deployments.
4. **Supabase CLI** (optional for manual Edge Function deployment): Available via `npx supabase`.

---

## 3. Deployment Steps

### Step A: Push Code to GitHub

Verify git status and push to the `main` branch:

```bash
# Check clean status
git status

# Stage all production assets
git add .

# Commit changes
git commit -m "feat: complete pharmacy store management system with supabase auth and edge functions"

# Push to GitHub
git push origin main
```

---

### Step B: Deploy Frontend on Vercel

1. Log in to the [Vercel Dashboard](https://vercel.com).
2. Click **Add New Project** → Import the `mrvr-tech/parmacy-store` repository.
3. Configure Project Settings:
   - **Framework Preset**: `Other`
   - **Root Directory**: `./`
   - **Build Command**: *(Leave empty)*
   - **Output Directory**: *(Leave empty / root)*
4. Configure **Environment Variables** in Vercel (*Project Settings → Environment Variables*):

| Variable Name | Description | Example / Required Value |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Your Supabase Project URL | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Public Anon/Publishable Key | `eyJhbGciOi...` *(Public safe key)* |
| `DEFAULT_EMAIL_DOMAIN` | Domain for username logins | `pharmacy.com` |

5. Click **Deploy**.

> **Note**: For local development or client-side runtime config without build steps, update [`js/config.js`](file:///c:/Users/Admin/.antigravity/jbvp%20store/js/config.js) with your project URL and publishable anon key.

---

### Step C: Deploy Supabase Edge Function

Deploy the privileged administrative Edge Function to Supabase:

```bash
# 1. Link your local project to Supabase
npx supabase link --project-ref <your-project-ref>

# 2. Deploy the admin-management function
npx supabase functions deploy admin-management

# 3. (Optional) Set secrets if not automatically injected
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

---

## 4. Environment Variables & Secrets Reference

### Frontend Environment (Vercel)
> ⚠️ **Zero Privileged Secrets**: The frontend only receives public safe keys (`SUPABASE_ANON_KEY`). Never expose `SUPABASE_SERVICE_ROLE_KEY` in Vercel or frontend files!

- `SUPABASE_URL`: Points to your Supabase project instance.
- `SUPABASE_ANON_KEY`: Public client key enforcing RLS.
- `DEFAULT_EMAIL_DOMAIN`: Default suffix for username-based login resolution (`pharmacy.com`).

### Edge Function Environment (Supabase Cloud)
> Injected automatically by the Supabase Edge Runtime:

- `SUPABASE_URL`: Automatic project URL.
- `SUPABASE_ANON_KEY`: Automatic anon key for token verification.
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key enabling administrative user and laboratory provisioning.

---

## 5. Post-Deployment Verification Checklist

After deploying the frontend and Edge Function, complete these production verification steps:

- [ ] **1. Store/Admin Login**: Log in as Store Keeper (`vedantpatil230406@gmail.com` or `admin`). Confirm redirect to `store/dashboard.html` with display name in navigation.
- [ ] **2. Vendor Login**: Log in as a Vendor User (e.g. `vendor1@pharmacy.com` or `vendor1`). Confirm redirect to `lab/dashboard.html`.
- [ ] **3. Access Control**: Ensure Vendor users cannot navigate to `store/dashboard.html` or any `/store/*` URL.
- [ ] **4. Inventory Entry**: In `store/add-item.html`, submit a new item. Verify it appears on `store/inventory.html` and `store/dashboard.html`.
- [ ] **5. Vendor Requisition**: In `lab/request-item.html`, submit a requisition for stock. Verify it displays under `lab/request-history.html` as `Pending`.
- [ ] **6. Store Approval**: In `store/approve-requests.html`, approve the requisition. Verify store inventory stock decreases and vendor request status becomes `Approved`.
- [ ] **7. User Management**: In `store/user-management.html`, add a test user and verify role and vendor assignments.
- [ ] **8. Vendor Management**: In `store/user-management.html`, add a test vendor and verify dependency protection prevents accidental deletion.
- [ ] **9. Reports**: In `store/reports.html`, verify Purchase, Vendor Usage, and Current Stock tables generate accurately and export cleanly to PDF/CSV.
- [ ] **10. Logout**: Test logout from both Store and Vendor portals to ensure session cache is cleanly purged.
