# GitHub Actions Workflows

This directory contains automated workflows for the NYC Financials project.

## Workflows

### 🔄 Seed All Data (`seed-all-data.yml`)

Automatically seeds housing, capital budget, and financial data from NYC Open Data APIs into the PostgreSQL database.

**Key Features:**
- ⏰ **Scheduled:** Weekly on Sundays at midnight UTC
- 🎯 **Manual Trigger:** Run anytime via workflow_dispatch with selective script execution
- 🔁 **Retry Logic:** Up to 3 automatic retries on failure
- 📢 **Notifications:** Discord webhook alerts on failure (after all retries)
- 🔒 **Secure:** Uses GitHub Secrets for sensitive data
- ⚡ **Efficient:** Prevents concurrent runs, 20-minute timeout
- 📊 **Monitoring:** Workflow summaries and artifact logs

**Quick Start:**

1. **Set up GitHub Secrets:**
   - `DATABASE_URL` - Supabase PostgreSQL connection string
   - `DISCORD_WEBHOOK_URL` - Discord webhook for failure alerts

2. **Test the workflow:**
   - Go to Actions → Seed All Data → Run workflow
   - Verify success in workflow logs and database

3. **Monitor:**
   - Check Actions tab for workflow runs
   - Receive Discord notifications on failures

**For detailed setup instructions, see [SETUP.md](./SETUP.md)**

---

## Addressing Open Questions

### 1. Should Discord notification include a summary of seeded data?

**Answer:** **Not in the current implementation.** Here's why:

- **Failure notifications** focus on alerting you to problems, not successes
- The notification includes a link to workflow logs where you can see detailed output
- For **success summaries**, check the GitHub Actions "Generate seed summary" step

**If you want success notifications with summaries:**

You can add a success notification step to the workflow:

```yaml
- name: Send Discord notification on success
  if: success()
  env:
    DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
  run: |
    # Create success notification payload
    # Include counts of seeded records, timestamps, etc.
```

**Recommendation:** Success notifications can get noisy for weekly runs. Consider:
- Only sending success notifications after manual runs
- Using GitHub Actions email notifications for scheduled runs
- Implementing a dashboard that displays the last successful seed timestamp

---

### 2. Should successful runs be logged anywhere?

**Answer:** **Yes, successful runs are already logged in multiple places:**

1. **GitHub Actions Summary:**
   - Each successful run generates a summary with:
     - Timestamp
     - Trigger type (scheduled vs manual)
     - List of scripts executed
     - Link to workflow run

2. **GitHub Actions Run Logs:**
   - Complete execution logs are available for 90 days
   - Navigate to Actions → Seed All Data → [specific run]

3. **Workflow Run History:**
   - GitHub maintains a history of all runs with status indicators

**Additional Logging Options (not currently implemented):**

- **Artifacts:** Upload success logs as artifacts (retention: 7-90 days)
- **External Logging:** Send logs to a service like Datadog, CloudWatch, or Papertrail
- **Database Logging:** Create a `seed_history` table to track seed operations:
  ```sql
  CREATE TABLE seed_history (
    id SERIAL PRIMARY KEY,
    script_name VARCHAR(255),
    status VARCHAR(50),
    records_inserted INT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
  );
  ```

**Recommendation:** The current logging (GitHub Actions Summary + Run Logs) is sufficient for most use cases. If you need long-term historical data, implement database logging in your seed scripts.

---

### 3. Should there be a way to run individual seed scripts via workflow_dispatch parameters?

**Answer:** **Yes, this is already implemented!**

The workflow includes three boolean inputs for manual runs:

- `run_housing` - Run housing seed script (default: true)
- `run_capital` - Run capital budget seed script (default: true)
- `run_financial` - Run financial seed script (default: true)

**How to use:**

1. Go to Actions → Seed All Data → Run workflow
2. Uncheck scripts you want to skip
3. Click Run workflow

**Example use cases:**

- **Test a single script:** Uncheck all except the one you want to test
- **Skip problematic script:** If one script is failing, run only the working ones
- **Debug incrementally:** Run scripts one at a time to isolate issues
- **Partial updates:** Update only housing data without touching financial data

**Note:** Scheduled runs (cron) always run all three scripts. Only manual triggers allow selective execution.

---

### 4. Do you recommend any additional error handling beyond the 3 retries?

**Answer:** **Yes, here are additional error handling recommendations:**

#### Implemented in Current Workflow:

✅ **3 automatic retries** with 30-second wait between attempts
✅ **Discord notifications** on complete failure
✅ **Timeout protection** (20 minutes total, 15 minutes per seed attempt)
✅ **Concurrency control** to prevent overlapping runs
✅ **Log artifacts** uploaded on failure for post-mortem analysis

#### Recommended Additional Error Handling:

1. **Exponential Backoff** (Currently linear 30s wait)
   - Modify retry wait: 30s → 60s → 120s
   - Helps with transient API rate limits

2. **Graceful Degradation in Seed Scripts**
   - Implement try-catch blocks around individual API calls
   - Allow partial success (e.g., seed 80% of records even if 20% fail)
   - Log failed records for manual review

3. **Health Checks Before Seeding**
   - Add a step to verify database connectivity before running scripts
   - Check NYC Open Data API availability
   - Example:
     ```yaml
     - name: Health check database
       run: |
         psql "$DATABASE_URL" -c "SELECT 1" || exit 1
     ```

4. **Monitoring and Alerting**
   - Set up GitHub Actions status checks
   - Create a dashboard showing workflow success rate
   - Use GitHub Apps like [Pull Panda](https://pullpanda.com/) for Slack integration

5. **Circuit Breaker Pattern**
   - If a specific API endpoint fails repeatedly, skip it temporarily
   - Implement in seed scripts:
     ```javascript
     if (failureCount[endpoint] > 5) {
       console.warn(`Skipping ${endpoint} due to repeated failures`);
       return;
     }
     ```

6. **Incremental Seeding**
   - Instead of clearing and repopulating all data, use upserts
   - Only update changed records
   - Reduces impact of partial failures

7. **Validation Step**
   - After seeding, run basic sanity checks:
     - Record counts are within expected ranges
     - No null values in required fields
     - Data freshness (timestamps are recent)
   - Example:
     ```yaml
     - name: Validate seeded data
       run: npm run validate:seed
     ```

8. **Rollback Mechanism**
   - Take a database snapshot before seeding
   - Restore on failure
   - **Caution:** Requires additional storage and time

#### Priority Recommendations:

**High Priority:**
- ✅ Already implemented: Retries, timeouts, notifications
- 🔴 Add health checks before seeding
- 🔴 Implement validation after seeding

**Medium Priority:**
- 🟡 Exponential backoff for retries
- 🟡 Graceful degradation in seed scripts

**Low Priority:**
- 🟢 Circuit breaker pattern
- 🟢 Incremental seeding
- 🟢 Rollback mechanism

---

## Best Practices

### Security

- ✅ Store all sensitive data in GitHub Secrets
- ✅ Never commit credentials to the repository
- ✅ Regularly rotate database passwords
- ✅ Use read-only database users if possible (not applicable for seeding)

### Performance

- ✅ Use `cache: 'npm'` to speed up dependency installation
- ✅ Set reasonable timeouts to prevent hanging workflows
- ✅ Run workflows during low-traffic periods

### Reliability

- ✅ Implement retry logic for transient failures
- ✅ Use concurrency controls to prevent race conditions
- ✅ Monitor workflow success rates
- ✅ Test workflows manually before relying on schedules

### Maintainability

- ✅ Document workflows thoroughly (see SETUP.md)
- ✅ Use descriptive names for steps and jobs
- ✅ Keep workflows simple and focused
- ✅ Version control workflow changes

---

## Contributing

When modifying workflows:

1. Test changes manually using workflow_dispatch
2. Review workflow syntax with [GitHub Actions validator](https://rhysd.github.io/actionlint/)
3. Update documentation (SETUP.md, README.md)
4. Test failure scenarios to ensure notifications work
5. Commit changes with clear messages

---

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Workflow Syntax Reference](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [GitHub Actions Best Practices](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Action: retry@v3](https://github.com/nick-fields/retry) - Used for retry logic

---

**Questions or issues?** Open an issue in the repository.
