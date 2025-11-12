// ABOUTME: Shared utilities for database seeding scripts
// ABOUTME: Provides database connection, progress logging, and error handling helpers

import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../../server/lib/schema.ts';

/**
 * Initialize database connection for seeding
 */
export function initDb() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    console.error('Please create a .env file with your Supabase connection string');
    console.error('See .env.example for format');
    process.exit(1);
  }

  console.log('[Seed] Connecting to database...');

  const client = postgres(connectionString, {
    max: 1, // Single connection for seeding
    onnotice: () => {}, // Suppress notices during bulk inserts
  });

  const db = drizzle(client, { schema });

  console.log('[Seed] Database connection established\n');

  return { db, client };
}

/**
 * Fetch data from NYC Open Data with pagination
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @param {number} options.limit - Records per page
 * @param {number} options.totalLimit - Maximum total records to fetch
 * @param {string} options.where - SoQL WHERE clause
 * @param {string} options.order - SoQL ORDER clause
 * @param {object} options.params - Additional query parameters (e.g., fiscal_year, publication_date)
 * @returns {Promise<Array>} All records
 */
export async function fetchNycOpenData(url, options = {}) {
  const {
    limit = 10000, // Reduced from 50000 to avoid timeouts
    totalLimit = Infinity,
    where = null,
    order = null,
    params: customParams = {},
  } = options;

  let allRecords = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && allRecords.length < totalLimit) {
    const params = new URLSearchParams({
      $limit: limit.toString(),
      $offset: offset.toString(),
      ...customParams, // Spread custom parameters
    });

    if (where) params.append('$where', where);
    if (order) params.append('$order', order);

    const fetchUrl = `${url}?${params.toString()}`;
    console.log(`[Fetch] Offset ${offset}...`);

    // Retry logic for this specific batch
    const maxRetries = 3;
    let retryCount = 0;
    let batch = null;

    while (retryCount < maxRetries) {
      try {
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

        const response = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        batch = await response.json();
        break; // Success, exit retry loop

      } catch (error) {
        retryCount++;

        if (error.name === 'AbortError') {
          console.error(`[Fetch] Request timed out (attempt ${retryCount}/${maxRetries})`);
        } else if (error.code === 'ECONNRESET' || error.errno === 0) {
          console.error(`[Fetch] Connection reset (attempt ${retryCount}/${maxRetries}): ${error.message}`);
        } else {
          console.error(`[Fetch] Error (attempt ${retryCount}/${maxRetries}):`, error.message);
        }

        if (retryCount >= maxRetries) {
          console.error(`[Fetch] Failed after ${maxRetries} attempts at offset ${offset}`);
          throw error;
        }

        // Exponential backoff: 2s, 4s, 8s
        const backoffMs = Math.pow(2, retryCount) * 1000;
        console.log(`[Fetch] Retrying in ${backoffMs / 1000}s...`);
        await sleep(backoffMs);
      }
    }

    if (batch === null || batch.length === 0) {
      hasMore = false;
      break;
    }

    allRecords = allRecords.concat(batch);
    console.log(`[Fetch] Retrieved ${batch.length} records (total: ${allRecords.length})`);

    offset += batch.length;

    // Stop if we got fewer records than the limit (last page)
    if (batch.length < limit) {
      hasMore = false;
    }

    // Respect rate limits - increased delay
    await sleep(500);
  }

  console.log(`[Fetch] Completed: ${allRecords.length} total records\n`);
  return allRecords.slice(0, totalLimit);
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Batch insert records with progress reporting
 * @param {object} db - Drizzle database instance
 * @param {object} table - Drizzle table definition
 * @param {Array} records - Records to insert
 * @param {object} options - Insert options
 * @param {number} options.batchSize - Number of records per batch
 * @param {string} options.label - Label for progress logging
 */
export async function batchInsert(db, table, records, options = {}) {
  const {
    batchSize = 500,
    label = 'records',
  } = options;

  if (records.length === 0) {
    console.log(`[Insert] No ${label} to insert\n`);
    return;
  }

  console.log(`[Insert] Inserting ${records.length} ${label} in batches of ${batchSize}...`);

  let inserted = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    try {
      await db.insert(table).values(batch).execute();
      inserted += batch.length;

      const percentage = ((inserted / records.length) * 100).toFixed(1);
      console.log(`[Insert] Progress: ${inserted}/${records.length} (${percentage}%)`);
    } catch (error) {
      console.error(`[Insert] Error inserting batch ${i}-${i + batch.length}:`, error.message);
      throw error;
    }
  }

  console.log(`[Insert] Successfully inserted ${inserted} ${label}\n`);
}

/**
 * Clear table before seeding (for fresh seed)
 * @param {object} db - Drizzle database instance
 * @param {string} tableName - Table name (string)
 * @param {string} label - Table label for logging
 */
export async function clearTable(db, tableName, label) {
  console.log(`[Clear] Clearing ${label} table...`);

  try {
    // Use TRUNCATE for faster, more reliable table clearing
    // RESTART IDENTITY resets auto-increment sequences
    // CASCADE removes dependent rows
    await db.execute(sql.raw(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`));
    console.log(`[Clear] Cleared ${label} table\n`);
  } catch (error) {
    console.error(`[Clear] Error clearing ${label}:`, error.message);
    throw error;
  }
}

/**
 * Gracefully close database connection
 */
export async function closeDb(client) {
  console.log('[Seed] Closing database connection...');
  await client.end();
  console.log('[Seed] Done!\n');
}

/**
 * Measure execution time
 */
export function timer() {
  const start = Date.now();

  return {
    stop() {
      const elapsed = Date.now() - start;
      const seconds = (elapsed / 1000).toFixed(2);
      const minutes = (elapsed / 60000).toFixed(2);

      if (elapsed < 60000) {
        return `${seconds}s`;
      } else {
        return `${minutes}m (${seconds}s)`;
      }
    }
  };
}

/**
 * Format numbers with commas
 */
export function formatNumber(num) {
  return num.toLocaleString('en-US');
}
