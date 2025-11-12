# GitHub Actions Data Seeding Setup Guide

This guide will help you set up and test the automated data seeding workflow for NYC Open Data.

## Table of Contents

- [Overview](#overview)
- [Setting Up GitHub Secrets](#setting-up-github-secrets)
- [Setting Up Discord Webhook](#setting-up-discord-webhook)
- [Testing the Workflow](#testing-the-workflow)
- [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)
- [FAQ](#faq)

---

## Overview

The `seed-all-data.yml` workflow automatically seeds housing, capital budget, and financial data from NYC Open Data APIs into your PostgreSQL database.

**Schedule:** Weekly on Sundays at midnight UTC (00:00 UTC)

**Runtime:** Approximately 2-3 minutes (all three scripts combined)

**Retry Policy:** Up to 3 automatic retries on failure with 30-second wait between attempts

**Notifications:** Discord webhook notifications sent only on complete failure (after all retries exhausted)

---

## Setting Up GitHub Secrets

GitHub Secrets are used to securely store sensitive information like database credentials and webhook URLs.

### 1. DATABASE_URL (Required)

This is your PostgreSQL connection string from Supabase.

**Steps to add:**

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Set the following:
   - **Name:** `DATABASE_URL`
   - **Secret:** Your Supabase connection string (format below)
5. Click **Add secret**

**Connection String Format:**
```
postgresql://[user]:[password]@[host]:[port]/[database]
```

**Example:**
```
postgresql://postgres.abcdefghij:MyP@ssw0rd@aws-0-us-west-1.pooler.supabase.com:5432/postgres
```

**Where to find your Supabase connection string:**

1. Log in to [Supabase](https://app.supabase.com)
2. Select your project
3. Go to **Project Settings** → **Database**
4. Scroll down to **Connection string** → **URI**
5. Copy the connection string (replace `[YOUR-PASSWORD]` with your actual database password)

### 2. DISCORD_WEBHOOK_URL (Required for Notifications)

This webhook is used to send failure notifications to Discord.

**Steps to add:**

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Set the following:
   - **Name:** `DISCORD_WEBHOOK_URL`
   - **Secret:** Your Discord webhook URL (see below for how to create one)
5. Click **Add secret**

---

## Setting Up Discord Webhook

Discord webhooks allow the workflow to send notifications to a specific Discord channel.

### Creating a Discord Webhook

1. **Open Discord** and navigate to the server where you want to receive notifications

2. **Select or create a channel** (e.g., `#github-alerts` or `#data-seeding`)

3. **Open Channel Settings:**
   - Right-click on the channel
   - Click **Edit Channel**

4. **Navigate to Integrations:**
   - Click **Integrations** in the left sidebar
   - Click **Webhooks**

5. **Create New Webhook:**
   - Click **New Webhook**
   - Give it a name (e.g., "NYC Data Seeding Bot")
   - Optionally upload an icon/avatar
   - Click **Copy Webhook URL**

6. **Save the Webhook:**
   - Click **Save Changes**

7. **Add to GitHub Secrets:**
   - Use the copied webhook URL as the value for `DISCORD_WEBHOOK_URL` secret (see above)

### Example Discord Notification

When a failure occurs, you'll receive a Discord message like this:

```
❌ Data Seeding Failed

All retry attempts (3) have been exhausted.

📅 Timestamp: 2025-11-12 00:15:43 UTC
🔄 Trigger: Scheduled (cron)
📝 Repository: ShouwangH/nyc-financials
🔗 Workflow Run: View Logs
⚠️ Action Required: Please check the workflow logs for detailed error messages
                    and investigate the cause of the failure.

NYC Open Data Seeding Workflow
```

---

## Testing the Workflow

Before the first scheduled run, test the workflow manually to ensure everything works correctly.

### Option 1: Run All Scripts (Default)

1. Go to your GitHub repository
2. Click **Actions** tab
3. Click **Seed All Data** workflow in the left sidebar
4. Click **Run workflow** dropdown (on the right side)
5. Keep all checkboxes checked (default)
6. Click **Run workflow** button
7. Wait for the workflow to complete (2-3 minutes)

### Option 2: Run Individual Scripts

You can test individual scripts to isolate issues:

1. Go to your GitHub repository
2. Click **Actions** tab
3. Click **Seed All Data** workflow in the left sidebar
4. Click **Run workflow** dropdown
5. **Uncheck scripts you want to skip:**
   - ☑️ Run housing seed script
   - ☐ Run capital budget seed script
   - ☐ Run financial seed script
6. Click **Run workflow** button

### Verifying Success

**In GitHub Actions:**
- Check that all steps have green checkmarks ✅
- Review the "Generate seed summary" step for a summary

**In your database:**
- Connect to your Supabase database
- Verify data in tables:
  - `sankey_datasets` (budget and pension sankeys)
  - `sunburst_datasets` (revenue and expense sunbursts)
  - Housing tables
  - Capital budget tables

**Example SQL queries to verify:**
```sql
-- Check sankey datasets
SELECT id, name, type, created_at FROM sankey_datasets ORDER BY created_at DESC;

-- Check sunburst datasets
SELECT id, name, type, created_at FROM sunburst_datasets ORDER BY created_at DESC;

-- Count total records
SELECT
  (SELECT COUNT(*) FROM sankey_datasets) as sankey_count,
  (SELECT COUNT(*) FROM sunburst_datasets) as sunburst_count;
```

---

## Monitoring and Troubleshooting

### Viewing Workflow Runs

1. Go to your GitHub repository
2. Click **Actions** tab
3. Click **Seed All Data** workflow
4. View the list of workflow runs with their status

### Understanding Workflow Status

- ✅ **Success:** All scripts completed successfully
- ❌ **Failure:** One or more scripts failed after 3 retries
- 🟡 **In Progress:** Workflow is currently running
- ⚪ **Cancelled:** Workflow was manually cancelled

### Common Issues and Solutions

#### Issue: "Database connection failed"

**Possible causes:**
- Invalid `DATABASE_URL` secret
- Database is down or unreachable
- Firewall rules blocking GitHub Actions IPs

**Solutions:**
1. Verify `DATABASE_URL` is correct in GitHub Secrets
2. Check Supabase project status
3. Ensure your Supabase project allows connections from external IPs

#### Issue: "npm run seed:all not found"

**Possible causes:**
- `package.json` doesn't have the seed scripts defined
- Incorrect script names

**Solutions:**
1. Verify `package.json` has these scripts:
```json
{
  "scripts": {
    "seed:housing": "bun run scripts/seed-housing.js",
    "seed:capital": "bun run scripts/seed-capital-budget.js",
    "seed:financial": "bun run scripts/seed-financial.js",
    "seed:all": "bun run seed:housing && bun run seed:capital && bun run seed:financial"
  }
}
```

#### Issue: "API rate limit exceeded"

**Possible causes:**
- Too many requests to NYC Open Data APIs

**Solutions:**
1. NYC Open Data typically doesn't have strict rate limits
2. If this occurs, the retry mechanism should handle it
3. Consider adding delays between API calls in the seed scripts

#### Issue: "Timeout after 20 minutes"

**Possible causes:**
- Scripts are taking longer than expected
- Network issues causing slow API responses

**Solutions:**
1. Check NYC Open Data API status
2. Increase `timeout-minutes` in the workflow if needed
3. Review script logs to identify which script is slow

### Downloading Failure Logs

When a workflow fails, logs are automatically uploaded as artifacts:

1. Go to the failed workflow run
2. Scroll down to **Artifacts** section
3. Download `seed-failure-logs-[run-id]`
4. Extract and review the log files

---

## FAQ

### Q: Can I change the schedule?

**A:** Yes, edit the cron expression in `.github/workflows/seed-all-data.yml`:

```yaml
schedule:
  - cron: '0 0 * * 0'  # Weekly on Sundays at midnight UTC
```

Common schedules:
- Daily at midnight: `0 0 * * *`
- Every Monday at 3 AM: `0 3 * * 1`
- Twice daily (midnight and noon): `0 0,12 * * *`

Use [crontab.guru](https://crontab.guru/) to create custom schedules.

### Q: How do I disable notifications temporarily?

**A:** Two options:

1. **Remove the secret:** Delete `DISCORD_WEBHOOK_URL` from GitHub Secrets (workflow will continue but notifications will fail silently)

2. **Comment out the notification step:** Edit the workflow file and add `if: false` to the Discord notification step:

```yaml
- name: Send Discord notification on failure
  if: false  # Temporarily disabled
  env:
    DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
```

### Q: Can successful runs be logged?

**A:** Yes, successful runs are logged in two places:

1. **GitHub Actions Summary:** Each successful run creates a summary with timestamps and scripts executed
2. **Workflow Artifacts:** You can modify the workflow to upload success logs as artifacts

To add success artifacts, add this step before the failure artifact step:

```yaml
- name: Upload logs as artifact on success
  if: success()
  uses: actions/upload-artifact@v4
  with:
    name: seed-success-logs-${{ github.run_id }}
    path: |
      npm-debug.log*
      *.log
    retention-days: 7
    if-no-files-found: ignore
```

### Q: What happens if the workflow runs while data is being used?

**A:** The seed scripts are designed to be idempotent (they clear and repopulate tables). The `concurrency` setting ensures only one workflow runs at a time, preventing race conditions. However, during seeding:

- Data in the affected tables will be temporarily cleared
- Applications querying during this time may get empty results
- The entire process takes 2-3 minutes

**Recommendations:**
- Schedule the workflow during low-traffic periods
- Implement caching in your application
- Use read replicas if available

### Q: How do I run individual scripts on a schedule?

**A:** Create separate workflow files for each script:

Example: `.github/workflows/seed-housing-only.yml`

```yaml
name: Seed Housing Data Only

on:
  schedule:
    - cron: '0 2 * * 1'  # Mondays at 2 AM UTC
  workflow_dispatch:

jobs:
  seed-housing:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      # ... (same setup steps)
      - name: Run housing seed script
        run: npm run seed:housing
```

### Q: Should I worry about database costs?

**A:** The workflow makes read queries to NYC Open Data (free) and writes to your Supabase database. Costs depend on:

- **Supabase tier:** Free tier has generous limits
- **Data volume:** The scripts seed a few thousand records
- **Frequency:** Weekly runs should be well within free tier limits

Monitor your Supabase usage dashboard to track consumption.

### Q: Can I seed data from a different environment?

**A:** Yes, you can create multiple workflows for different environments:

1. Create separate secrets for each environment:
   - `DATABASE_URL_DEV`
   - `DATABASE_URL_STAGING`
   - `DATABASE_URL_PROD`

2. Create separate workflow files:
   - `seed-all-data-dev.yml`
   - `seed-all-data-staging.yml`
   - `seed-all-data.yml` (production)

3. Use the appropriate secret in each workflow

---

## Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Supabase Documentation](https://supabase.com/docs)
- [NYC Open Data Platform](https://opendata.cityofnewyork.us/)
- [Cron Expression Generator](https://crontab.guru/)
- [Discord Webhooks Guide](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)

---

## Support

If you encounter issues not covered in this guide:

1. Check the workflow logs in GitHub Actions
2. Review the seed script source code in `scripts/`
3. Verify database schema in `server/lib/schema.ts`
4. Check Discord for failure notifications with detailed error messages

---

**Last Updated:** 2025-11-12

**Workflow Version:** 1.0.0
