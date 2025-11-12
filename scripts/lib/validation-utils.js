#!/usr/bin/env node

/**
 * Validation utilities for NYC Open Data seeding
 * Ensures data quality before clearing existing database records
 */

import { sql } from 'drizzle-orm';

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * Validate minimum record count
 * Prevents clearing database if API returns too few records
 */
export function validateMinimumRecordCount(records, minCount, datasetName) {
  if (!Array.isArray(records)) {
    throw new ValidationError(
      `${datasetName}: Expected array of records, got ${typeof records}`,
      { received: typeof records, expected: 'array' }
    );
  }

  if (records.length < minCount) {
    throw new ValidationError(
      `${datasetName}: Insufficient records (${records.length} < ${minCount} minimum)`,
      {
        received: records.length,
        minimum: minCount,
        dataset: datasetName,
        suggestion: 'API may be returning incomplete data or rate limiting. Check API status.'
      }
    );
  }

  console.log(`[Validation] ✓ ${datasetName}: ${records.length} records (minimum: ${minCount})`);
  return true;
}

/**
 * Validate required fields exist in records
 * Detects schema changes in NYC Open Data APIs
 * @param {Array} records - Records to validate
 * @param {Array} requiredFields - Fields that should be present
 * @param {string} datasetName - Name of dataset for error messages
 * @param {number} sampleSize - Number of records to check (default: 10)
 * @param {number} maxFailureRate - Maximum acceptable failure rate as percentage (default: 10)
 */
export function validateRequiredFields(records, requiredFields, datasetName, sampleSize = 10, maxFailureRate = 10) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ValidationError(
      `${datasetName}: No records to validate`,
      { recordCount: records?.length || 0 }
    );
  }

  // Sample records for validation (check first N records)
  const samplesToCheck = Math.min(sampleSize, records.length);
  const missingFieldsByRecord = [];

  for (let i = 0; i < samplesToCheck; i++) {
    const record = records[i];
    const missingFields = [];

    for (const field of requiredFields) {
      if (!(field in record)) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      missingFieldsByRecord.push({
        recordIndex: i,
        missingFields
      });
    }
  }

  if (missingFieldsByRecord.length > 0) {
    // Calculate percentage of records with missing fields
    const failureRate = (missingFieldsByRecord.length / samplesToCheck) * 100;

    // Only throw error if failure rate exceeds threshold
    if (failureRate > maxFailureRate) {
      throw new ValidationError(
        `${datasetName}: ${missingFieldsByRecord.length}/${samplesToCheck} sampled records have missing required fields (${failureRate.toFixed(1)}% > ${maxFailureRate}% threshold)`,
        {
          dataset: datasetName,
          failureRate: `${failureRate.toFixed(1)}%`,
          threshold: `${maxFailureRate}%`,
          requiredFields,
          sampleSize: samplesToCheck,
          failures: missingFieldsByRecord.slice(0, 3), // Show first 3 examples
          suggestion: 'API schema may have changed. Review field names in NYC Open Data documentation.'
        }
      );
    }

    // Warn but don't fail if within acceptable threshold
    console.log(`[Validation] ⚠️  ${datasetName}: ${missingFieldsByRecord.length}/${samplesToCheck} records missing fields (${failureRate.toFixed(1)}% - within ${maxFailureRate}% threshold)`);
    return true;
  }

  console.log(`[Validation] ✓ ${datasetName}: All required fields present (checked ${samplesToCheck} records)`);
  return true;
}

/**
 * Validate data types for critical fields
 * Ensures numeric fields are parseable, dates are valid, etc.
 */
export function validateDataTypes(records, fieldValidators, datasetName, sampleSize = 10) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ValidationError(
      `${datasetName}: No records to validate`,
      { recordCount: records?.length || 0 }
    );
  }

  const samplesToCheck = Math.min(sampleSize, records.length);
  const typeErrors = [];

  for (let i = 0; i < samplesToCheck; i++) {
    const record = records[i];

    for (const [field, validator] of Object.entries(fieldValidators)) {
      const value = record[field];

      try {
        const isValid = validator(value, record);
        if (!isValid) {
          typeErrors.push({
            recordIndex: i,
            field,
            value,
            error: 'Validator returned false'
          });
        }
      } catch (error) {
        typeErrors.push({
          recordIndex: i,
          field,
          value,
          error: error.message
        });
      }
    }
  }

  if (typeErrors.length > 0) {
    const failureRate = (typeErrors.length / (samplesToCheck * Object.keys(fieldValidators).length)) * 100;

    throw new ValidationError(
      `${datasetName}: ${typeErrors.length} type validation errors in ${samplesToCheck} sampled records`,
      {
        dataset: datasetName,
        failureRate: `${failureRate.toFixed(1)}%`,
        sampleSize: samplesToCheck,
        failures: typeErrors.slice(0, 5), // Show first 5 examples
        suggestion: 'Data format may have changed. Review NYC Open Data documentation.'
      }
    );
  }

  console.log(`[Validation] ✓ ${datasetName}: All data types valid (checked ${samplesToCheck} records)`);
  return true;
}

/**
 * Validate processed data before database insertion
 * Final check after transformation
 */
export function validateProcessedRecords(records, validations, datasetName) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ValidationError(
      `${datasetName}: No processed records to validate`,
      { recordCount: records?.length || 0 }
    );
  }

  console.log(`[Validation] Validating ${records.length} processed ${datasetName} records...`);

  // Run all validation checks
  const errors = [];

  for (const validation of validations) {
    try {
      validation(records);
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(error);
      } else {
        errors.push(new ValidationError(error.message, { originalError: error }));
      }
    }
  }

  if (errors.length > 0) {
    // Combine all errors
    const errorMessages = errors.map(e => e.message).join('; ');
    throw new ValidationError(
      `${datasetName}: ${errors.length} validation error(s): ${errorMessages}`,
      {
        dataset: datasetName,
        errors: errors.map(e => ({
          message: e.message,
          details: e.details
        }))
      }
    );
  }

  console.log(`[Validation] ✓ ${datasetName}: All processed records validated successfully\n`);
  return true;
}

/**
 * Common validators for reuse
 */
export const validators = {
  // Numeric validators
  isNumber: (value) => {
    const num = parseFloat(value);
    return !isNaN(num) && isFinite(num);
  },

  isPositiveNumber: (value) => {
    const num = parseFloat(value);
    return !isNaN(num) && isFinite(num) && num > 0;
  },

  isInteger: (value) => {
    const num = parseInt(value, 10);
    return !isNaN(num) && isFinite(num) && num === parseFloat(value);
  },

  // Date validators
  isValidDate: (value) => {
    if (!value) return false;
    const date = new Date(value);
    return date instanceof Date && !isNaN(date.getTime());
  },

  isYearInRange: (min, max) => (value) => {
    const year = parseInt(value, 10);
    return !isNaN(year) && year >= min && year <= max;
  },

  // String validators
  isNonEmptyString: (value) => {
    return typeof value === 'string' && value.trim().length > 0;
  },

  // Coordinate validators
  isValidLatitude: (value) => {
    const lat = parseFloat(value);
    return !isNaN(lat) && isFinite(lat) && lat >= -90 && lat <= 90 && lat !== 0;
  },

  isValidLongitude: (value) => {
    const lon = parseFloat(value);
    return !isNaN(lon) && isFinite(lon) && lon >= -180 && lon <= 180 && lon !== 0;
  },

  // BBL validator (10-digit NYC property identifier)
  isValidBBL: (value) => {
    if (!value) return true; // BBL can be optional
    const bbl = String(value).replace(/[^0-9]/g, '');
    return bbl.length === 10;
  },
};

/**
 * Create a summary of validation results for logging
 */
export function createValidationSummary(datasetName, recordCount, validationsPassed) {
  return {
    dataset: datasetName,
    recordCount,
    validationsPassed,
    timestamp: new Date().toISOString(),
    status: 'PASSED'
  };
}

/**
 * Log validation error with detailed information
 */
export function logValidationError(error) {
  console.error('\n╔════════════════════════════════════════════════════════════╗');
  console.error('║                   VALIDATION FAILED                        ║');
  console.error('╚════════════════════════════════════════════════════════════╝\n');

  if (error instanceof ValidationError) {
    console.error(`[ERROR] ${error.message}\n`);

    if (error.details && Object.keys(error.details).length > 0) {
      console.error('Details:');
      console.error(JSON.stringify(error.details, null, 2));
    }
  } else {
    console.error('[ERROR] Unexpected validation error:', error.message);
    console.error(error.stack);
  }

  console.error('\n⚠️  Database tables were NOT cleared. Existing data is safe.');
  console.error('⚠️  Please investigate the validation error before retrying.\n');
}

/**
 * ========================================================================
 * CHANGE DETECTION UTILITIES
 * Skip database operations if data hasn't changed since last seed
 * ========================================================================
 */

/**
 * Calculate hash of dataset for change detection
 * Uses a simple but effective hashing approach
 */
function calculateDataHash(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return 'empty';
  }

  // Create a deterministic string representation
  // Include: record count, first record, last record, and sample middle records
  const summary = {
    count: records.length,
    first: JSON.stringify(records[0]),
    last: JSON.stringify(records[records.length - 1]),
    // Sample 5 records from the middle for hash
    samples: records
      .filter((_, idx) => idx % Math.floor(records.length / 5) === 0)
      .slice(0, 5)
      .map(r => JSON.stringify(r))
  };

  // Simple hash function (FNV-1a)
  const str = JSON.stringify(summary);
  let hash = 2166136261;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(16);
}

/**
 * Check if data has changed by comparing with existing database records
 * Returns: { hasChanges: boolean, reason: string, stats: object }
 */
export async function detectDataChanges(db, tableName, newRecords, options = {}) {
  const {
    compareFields = ['id'], // Fields to use for matching records
    hashData = true,         // Whether to hash data for quick comparison
    logDetails = true,       // Whether to log detailed comparison results
  } = options;

  console.log(`[Change Detection] Checking if ${tableName} needs update...`);

  try {
    // Get current record count from database
    const result = await db.execute(sql.raw(`SELECT COUNT(*) as count FROM ${tableName}`));
    const currentCount = parseInt(result.rows[0]?.count || result[0]?.count || 0, 10);

    const newCount = newRecords.length;

    if (logDetails) {
      console.log(`[Change Detection] Current records: ${currentCount}`);
      console.log(`[Change Detection] New records: ${newCount}`);
    }

    // Quick check: If counts differ significantly, data has changed
    if (Math.abs(currentCount - newCount) > 0) {
      const reason = currentCount === 0
        ? 'Table is empty - initial seed required'
        : `Record count changed (${currentCount} → ${newCount})`;

      console.log(`[Change Detection] ✓ Changes detected: ${reason}\n`);

      return {
        hasChanges: true,
        reason,
        stats: {
          currentCount,
          newCount,
          difference: newCount - currentCount
        }
      };
    }

    // If counts match and hashData is enabled, compare data hash
    if (hashData) {
      // Get a sample of existing records for hash comparison
      const existingRecords = await db.execute(sql.raw(`SELECT * FROM ${tableName} ORDER BY id LIMIT 1000`));

      const existingHash = calculateDataHash(existingRecords.rows || existingRecords || []);
      const newHash = calculateDataHash(newRecords.slice(0, 1000)); // Compare same sample size

      if (existingHash !== newHash) {
        const reason = 'Data content has changed (hash mismatch)';
        console.log(`[Change Detection] ✓ Changes detected: ${reason}`);
        console.log(`[Change Detection]   Old hash: ${existingHash}`);
        console.log(`[Change Detection]   New hash: ${newHash}\n`);

        return {
          hasChanges: true,
          reason,
          stats: {
            currentCount,
            newCount,
            existingHash,
            newHash
          }
        };
      }
    }

    // No changes detected
    console.log(`[Change Detection] ✓ No changes detected - skipping database update\n`);

    return {
      hasChanges: false,
      reason: 'Data is identical to existing records',
      stats: {
        currentCount,
        newCount
      }
    };

  } catch (error) {
    // If change detection fails, assume data has changed (fail-safe)
    console.warn(`[Change Detection] ⚠️  Error during change detection: ${error.message}`);
    console.warn(`[Change Detection] Proceeding with update to be safe...\n`);

    return {
      hasChanges: true,
      reason: 'Change detection failed - proceeding with update',
      error: error.message,
      stats: {}
    };
  }
}

/**
 * Check if we need to update by comparing timestamps
 * Useful for datasets with known update schedules
 */
export async function checkNeedsUpdate(db, tableName, maxAgeHours = 168) {
  console.log(`[Update Check] Checking last update time for ${tableName}...`);

  try {
    const result = await db.execute(sql.raw(`
      SELECT MAX(last_synced_at) as last_synced
      FROM ${tableName}
    `));
    const lastSynced = result.rows[0]?.last_synced || result[0]?.last_synced;

    if (!lastSynced) {
      console.log(`[Update Check] ✓ No previous sync found - update required\n`);
      return {
        needsUpdate: true,
        reason: 'Never synced before',
        lastSynced: null
      };
    }

    const lastSyncedDate = new Date(lastSynced);
    const now = new Date();
    const hoursSinceSync = (now - lastSyncedDate) / (1000 * 60 * 60);

    if (hoursSinceSync >= maxAgeHours) {
      console.log(`[Update Check] ✓ Data is stale (${hoursSinceSync.toFixed(1)}h old) - update required\n`);
      return {
        needsUpdate: true,
        reason: `Data is ${hoursSinceSync.toFixed(1)} hours old (max: ${maxAgeHours}h)`,
        lastSynced: lastSyncedDate,
        hoursSinceSync
      };
    }

    console.log(`[Update Check] ✓ Data is fresh (${hoursSinceSync.toFixed(1)}h old) - skipping update\n`);

    return {
      needsUpdate: false,
      reason: `Data is recent (${hoursSinceSync.toFixed(1)}h old)`,
      lastSynced: lastSyncedDate,
      hoursSinceSync
    };

  } catch (error) {
    // If check fails, assume update is needed (fail-safe)
    console.warn(`[Update Check] ⚠️  Error checking update time: ${error.message}`);
    console.warn(`[Update Check] Proceeding with update to be safe...\n`);

    return {
      needsUpdate: true,
      reason: 'Update check failed - proceeding with update',
      error: error.message
    };
  }
}
