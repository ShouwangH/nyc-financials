#!/usr/bin/env node

// ABOUTME: Seed script for capital budget data - fetches CPDB from NYC Open Data and stores in database
// ABOUTME: Replicates processing from server/routes/capital-budget.ts but stores results

import { capitalProjects } from '../server/lib/schema.ts';
import {
  initDb,
  closeDb,
  fetchNycOpenData,
  batchInsert,
  clearTable,
  timer,
  formatNumber,
} from './lib/seed-utils.js';
import {
  validateMinimumRecordCount,
  validateRequiredFields,
  validateDataTypes,
  validateProcessedRecords,
  validators,
  logValidationError,
  detectDataChanges,
} from './lib/validation-utils.js';

// NYC Open Data API endpoint
const CPDB_API = 'https://data.cityofnewyork.us/resource/9jkp-n57r.geojson';

/**
 * Calculate centroid of a GeoJSON geometry
 * Supports Point, Polygon, and MultiPolygon
 */
function calculateCentroid(geometry) {
  if (!geometry || !geometry.type) return [null, null];

  if (geometry.type === 'Point') {
    return geometry.coordinates;
  }

  let totalX = 0;
  let totalY = 0;
  let totalPoints = 0;

  const processRing = (ring) => {
    for (const [lon, lat] of ring) {
      totalX += lon;
      totalY += lat;
      totalPoints++;
    }
  };

  if (geometry.type === 'Polygon') {
    processRing(geometry.coordinates[0]); // Outer ring only
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      processRing(polygon[0]); // Outer ring of each polygon
    }
  }

  if (totalPoints === 0) return [null, null];
  return [totalX / totalPoints, totalY / totalPoints];
}

/**
 * Douglas-Peucker line simplification algorithm
 * Reduces number of points while preserving shape
 */
function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;

  // Find point with maximum distance from line between first and last
  let maxDist = 0;
  let maxIndex = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];

  // Check if endpoints are identical (would cause divide by zero)
  const lineLength = Math.sqrt((y2 - y1) ** 2 + (x2 - x1) ** 2);
  if (lineLength === 0) {
    // Endpoints are identical, return just the first point
    return [points[0]];
  }

  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    // Perpendicular distance from point to line
    const dist = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / lineLength;
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  // If max distance > tolerance, recursively simplify
  if (maxDist > tolerance) {
    const left = simplifyLine(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyLine(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  // Otherwise, return just endpoints
  return [points[0], points[points.length - 1]];
}

/**
 * Simplify a GeoJSON geometry using Douglas-Peucker algorithm
 * tolerance: in degrees (0.0001 ≈ 11 meters at NYC latitude)
 */
function simplifyGeometry(geometry, tolerance = 0.0001) {
  if (!geometry || !geometry.type) return geometry;

  if (geometry.type === 'Point') {
    return geometry; // Points can't be simplified
  }

  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map(ring => simplifyLine(ring, tolerance)),
    };
  }

  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map(polygon =>
        polygon.map(ring => simplifyLine(ring, tolerance))
      ),
    };
  }

  return geometry; // Return unchanged for other types
}

/**
 * Process CPDB GeoJSON records
 */
function processCapitalProjects(features) {
  console.log('[Process] Processing capital projects...');

  const projects = [];

  for (const feature of features) {
    const props = feature.properties;

    // Parse fiscal year from mindate
    const fiscalYear = props.mindate
      ? parseInt(props.mindate.substring(0, 4), 10)
      : null;

    // Parse completion year from maxdate
    const completionYear = props.maxdate
      ? parseInt(props.maxdate.substring(0, 4), 10)
      : null;

    // Data correction: Fix erroneous 100 billion value (should be 100 million)
    let allocateTotal = parseFloat(props.allocate_total || '0');
    if (allocateTotal >= 99e9 && allocateTotal <= 101e9) {
      allocateTotal = 100e6; // Correct to 100 million
    }

    // Pre-compute centroid for faster frontend rendering
    const [centroidLon, centroidLat] = calculateCentroid(feature.geometry);

    const project = {
      id: props.maprojid || `project-${Math.random().toString(36).substring(2, 11)}`,
      maprojid: props.maprojid || 'Unknown',
      description: props.description || 'Unnamed Project',

      managingAgency: props.magencyname || 'Unknown Agency',
      managingAgencyAcronym: props.magencyacro || 'N/A',

      typeCategory: props.typecategory || 'Unknown',

      minDate: props.mindate || null,
      maxDate: props.maxdate || null,
      fiscalYear,
      completionYear,

      allocateTotal,
      commitTotal: parseFloat(props.commit_total || '0'),
      spentTotal: parseFloat(props.spent_total || '0'),
      plannedCommitTotal: parseFloat(props.plannedcommit_total || '0'),

      // Store geometry as JSONB (PostGIS-compatible GeoJSON)
      geometry: feature.geometry,

      // Pre-computed centroid for faster rendering (Phase 2.1 optimization)
      centroidLon,
      centroidLat,

      // Simplified geometry for faster API responses (Phase 2.2 optimization)
      // ~82% smaller than full geometry
      geometrySimplified: simplifyGeometry(feature.geometry, 0.0001),

      lastSyncedAt: new Date(),
    };

    projects.push(project);
  }

  console.log(`[Process] Processed ${formatNumber(projects.length)} capital projects\n`);
  return projects;
}

/**
 * Main seed function
 */
async function main() {
  const t = timer();

  console.log('========================================');
  console.log('   NYC CAPITAL BUDGET SEED SCRIPT      ');
  console.log('========================================\n');

  // Initialize database
  const { db, client } = initDb();

  try {
    // Step 1: Fetch CPDB data (GeoJSON format)
    console.log('--- STEP 1: Fetch Capital Projects Data ---\n');

    // Fetch active/future projects with allocated budgets
    const url = `${CPDB_API}?$where=maxdate>='2025-01-01' AND allocate_total>0&$limit=10000`;

    console.log(`[Fetch] Fetching from: ${CPDB_API}`);
    console.log(`[Fetch] Filter: maxdate>='2025-01-01' AND allocate_total>0\n`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const geojson = await response.json();
    const features = geojson.features || [];

    console.log(`[Fetch] Retrieved ${formatNumber(features.length)} projects\n`);

    // Step 2: Validate raw data BEFORE processing
    console.log('--- STEP 2: Validate Capital Projects Data ---\n');
    try {
      // Minimum record count validation (expect at least 1000 active projects)
      validateMinimumRecordCount(features, 1000, 'Capital Projects');

      // Validate GeoJSON structure and required fields
      validateRequiredFields(
        features.map(f => f.properties),
        ['maprojid', 'description', 'magencyname', 'allocate_total'],
        'Capital Projects',
        30
      );

      // Data type validation
      validateDataTypes(
        features.map(f => f.properties),
        {
          allocate_total: (val) => validators.isNumber(val),
          commit_total: (val) => validators.isNumber(val),
          spent_total: (val) => validators.isNumber(val),
        },
        'Capital Projects',
        30
      );
    } catch (error) {
      logValidationError(error);
      process.exit(1);
    }

    // Step 3: Process projects
    console.log('--- STEP 3: Process Capital Projects ---\n');
    const projects = processCapitalProjects(features);

    // Step 4: Validate processed data
    console.log('--- STEP 4: Validate Processed Projects ---\n');
    try {
      validateProcessedRecords(
        projects,
        [
          (records) => validateMinimumRecordCount(records, 1000, 'Processed Capital Projects'),
          (records) => {
            // Ensure all projects have required fields
            const invalid = records.filter(r => !r.id || !r.maprojid || !r.description);
            if (invalid.length > 0) {
              throw new Error(`${invalid.length} projects missing required fields`);
            }
          },
        ],
        'Capital Projects'
      );
    } catch (error) {
      logValidationError(error);
      process.exit(1);
    }

    // Step 5: Check if data has changed
    console.log('--- STEP 5: Check for Data Changes ---\n');
    const changeResult = await detectDataChanges(db, 'capital_projects', projects);

    // Only update if changes detected
    if (!changeResult.hasChanges) {
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║          NO CHANGES DETECTED - SKIPPING UPDATE             ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');
      console.log('✓ Capital projects: No changes');
      console.log('\n💡 Database is already up to date. Seed skipped to save resources.\n');

      const totalTime = t.stop();
      console.log('========================================');
      console.log('           SEED SUMMARY                 ');
      console.log('========================================');
      console.log('Status: SKIPPED (No changes detected)');
      console.log(`Total Time: ${totalTime}`);
      console.log('========================================\n');
      return;
    }

    // Step 6: Clear existing data (only if changes detected)
    console.log('--- STEP 6: Clear Existing Data ---\n');
    console.log('⚠️  Changes detected - clearing table and inserting new data...\n');

    await clearTable(db, 'capital_projects', 'capital_projects');

    // Step 7: Insert into database
    console.log('--- STEP 7: Insert into Database ---\n');
    await batchInsert(db, capitalProjects, projects, {
      batchSize: 500,
      label: 'capital projects',
    });

    // Summary
    console.log('========================================');
    console.log('           SEED SUMMARY                 ');
    console.log('========================================');
    console.log(`Capital Projects: ${formatNumber(projects.length)}`);
    console.log(`Total Budget Allocated: $${formatNumber(projects.reduce((sum, p) => sum + p.allocateTotal, 0).toFixed(0))}`);
    console.log(`Total Time: ${t.stop()}`);
    console.log('========================================\n');

  } catch (error) {
    console.error('\n[ERROR] Seed failed:', error);
    process.exit(1);
  } finally {
    await closeDb(client);
  }
}

// Run the seed script
main();
