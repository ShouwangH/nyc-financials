#!/usr/bin/env node

// ABOUTME: Seed script for housing data using DCP Housing Database (ArcGIS) as primary source
// ABOUTME: Overlays Housing NY data for affordable unit details

import { housingBuildings, housingDemolitions } from '../server/lib/schema.ts';
import {
  initDb,
  closeDb,
  fetchNycOpenData,
  batchInsert,
  clearTable,
  timer,
  formatNumber,
} from './lib/seed-utils.js';
import { fetchArcGISFeatures } from './lib/arcgis-utils.js';
import {
  validateMinimumRecordCount,
  validateRequiredFields,
  validateDataTypes,
  validateProcessedRecords,
  validators,
  logValidationError,
  detectDataChanges,
} from './lib/validation-utils.js';

// Data sources
const DCP_HOUSING_DATABASE_URL = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/ArcGIS/rest/services/Housing_Database/FeatureServer/0';
const HOUSING_NY_API = 'https://data.cityofnewyork.us/resource/hg8x-zxpr.json';

// Borough code mapping (DCP uses numeric codes)
const BOROUGH_NAMES = {
  '1': 'Manhattan',
  '2': 'Bronx',
  '3': 'Brooklyn',
  '4': 'Queens',
  '5': 'Staten Island',
};

/**
 * Normalize BBL to standard 10-digit format
 */
function normalizeBBL(bbl) {
  if (!bbl) return null;

  // Remove all non-numeric characters
  const numeric = String(bbl).replace(/[^0-9]/g, '');

  // BBL should be 10 digits: 1 (borough) + 5 (block) + 4 (lot)
  if (numeric.length === 10) return numeric;
  if (numeric.length === 9) return '0' + numeric; // Pad if missing leading zero

  return null;
}

/**
 * Determine physical building type from unit count and building class
 * This is the structural type, independent of affordability/renovation status
 */
function getPhysicalBuildingType(totalUnits, buildingClass) {
  // Check building class first for mixed-use
  if (buildingClass) {
    const classPrefix = buildingClass.charAt(0).toUpperCase();
    if (classPrefix === 'D' || classPrefix === 'O') {
      return 'mixed-use';
    }
  }

  // Physical building classification based on unit count
  if (totalUnits >= 50) return 'multifamily-elevator';
  if (totalUnits >= 10) return 'multifamily-walkup';
  if (totalUnits >= 3) return 'multifamily-walkup';
  if (totalUnits <= 2) return 'one-two-family';

  return 'unknown';
}

/**
 * Classify building type from total units, affordable status, job type, and building class
 */
function classifyBuildingType(totalUnits, affordableUnits, jobType, hasAffordableOverlay, buildingClass) {
  // If has affordable housing overlay, classify as affordable
  if (hasAffordableOverlay && affordableUnits > 0) {
    return 'affordable';
  }

  // Renovation/alteration
  if (jobType === 'Alteration') {
    return 'renovation';
  }

  // Otherwise use physical building type
  return getPhysicalBuildingType(totalUnits, buildingClass);
}

/**
 * Process DCP Housing Database records (new construction and alterations)
 */
function processDCPHousing(records) {
  console.log('[Process] Processing DCP Housing Database records...');

  const buildings = [];
  let skipped = 0;

  for (const record of records) {
    // Parse coordinates
    const lat = parseFloat(record.Latitude);
    const lon = parseFloat(record.Longitude);

    // Skip if invalid coordinates
    if (isNaN(lat) || isNaN(lon) || lat === 0 || lon === 0) {
      skipped++;
      continue;
    }

    // Parse completion year
    const completionYear = parseInt(record.CompltYear, 10);
    if (isNaN(completionYear) || completionYear < 2014 || completionYear > 2025) {
      skipped++;
      continue;
    }

    // Parse unit counts (ClassANet = net change in units, the correct value for totalUnits)
    const classANet = parseFloat(record.ClassANet) || 0;
    const unitsCO = parseFloat(record.Units_CO) || 0; // Store for reference, but don't use for totalUnits
    const totalUnits = Math.round(classANet);

    // Skip if no units (or negative for demolitions)
    if (totalUnits <= 0) {
      skipped++;
      continue;
    }

    const jobNumber = record.Job_Number || `DCP-${record.OBJECTID}`;
    const bbl = normalizeBBL(record.BBL);
    const borough = BOROUGH_NAMES[record.Boro] || 'Unknown';
    const address = `${record.AddressNum || ''} ${record.AddressSt || ''}`.trim() || 'Address Not Available';

    const building = {
      id: jobNumber,
      name: `${address}, ${borough}`,

      // DCP core fields
      jobNumber,
      jobType: record.Job_Type || 'Unknown',
      jobStatus: record.Job_Status || null,
      jobDescription: record.Job_Desc || null,

      // Location (from DCP - always present)
      longitude: lon,
      latitude: lat,
      address,
      borough,
      bbl,
      bin: record.BIN || null,

      // Geography
      communityDistrict: record.CommntyDst || null,
      councilDistrict: record.CouncilDst || null,
      censusTract2020: record.BCT2020 || null,
      nta2020: record.NTA2020 || null,
      ntaName2020: record.NTAName20 || null,

      // Completion dates
      completionYear,
      completionDate: record.DateComplt ? new Date(record.DateComplt).toISOString() : null,
      permitYear: parseInt(record.PermitYear, 10) || null,
      permitDate: record.DatePermit ? new Date(record.DatePermit).toISOString() : null,

      // Unit counts (from DCP)
      classAInit: Math.round(parseFloat(record.ClassAInit) || 0),
      classAProp: Math.round(parseFloat(record.ClassAProp) || 0),
      classANet: Math.round(classANet),
      unitsCO: Math.round(unitsCO),
      totalUnits,

      // Affordable housing (will be overlaid from Housing NY)
      affordableUnits: 0,
      affordablePercentage: 0,

      // Affordable unit breakdown (will be overlaid)
      extremeLowIncomeUnits: 0,
      veryLowIncomeUnits: 0,
      lowIncomeUnits: 0,
      moderateIncomeUnits: 0,
      middleIncomeUnits: 0,
      otherIncomeUnits: 0,

      // Bedroom breakdown (will be overlaid)
      studioUnits: 0,
      oneBrUnits: 0,
      twoBrUnits: 0,
      threeBrUnits: 0,
      fourBrUnits: 0,
      fiveBrUnits: 0,
      sixBrUnits: 0,
      unknownBrUnits: totalUnits, // All units have unknown bedroom count by default

      // Classification (will be updated after overlay)
      buildingType: classifyBuildingType(totalUnits, 0, record.Job_Type, false, record.Bldg_Class),
      physicalBuildingType: getPhysicalBuildingType(totalUnits, record.Bldg_Class),
      buildingClass: record.Bldg_Class || null,
      zoningDistrict1: record.ZoningDst1 || null,
      zoningDistrict2: record.ZoningDst2 || null,
      zoningDistrict3: record.ZoningDst3 || null,

      // Building details
      floorsInit: parseFloat(record.FloorsInit) || null,
      floorsProp: parseFloat(record.FloorsProp) || null,
      ownership: record.Ownership || null,

      // Source tracking
      dataSource: 'dcp',
      hasAffordableOverlay: false,

      // Housing NY fields (null by default)
      housingNyProjectId: null,
      housingNyProjectName: null,
      housingNyConstructionType: null,
      housingNyExtendedAffordabilityOnly: false,

      lastSyncedAt: new Date(),
    };

    buildings.push(building);
  }

  console.log(`[Process] Processed ${formatNumber(buildings.length)} DCP buildings`);
  console.log(`[Process] Skipped ${formatNumber(skipped)} records (invalid coords, years, or units)\n`);
  return buildings;
}

/**
 * Process Housing NY records (for affordable overlay)
 */
function processHousingNY(records) {
  console.log('[Process] Processing Housing NY records for affordable overlay...');

  const affordableMap = new Map(); // BBL -> affordable data

  for (const record of records) {
    const bbl = normalizeBBL(record.bbl);
    if (!bbl) continue;

    // Parse completion date
    const completionDate = record.building_completion_date;
    if (!completionDate) continue;

    const date = new Date(completionDate);
    const completionYear = date.getFullYear();

    // Filter to 2014-2025 range
    if (completionYear < 2014 || completionYear > 2025) continue;

    const totalUnits = parseInt(record.all_counted_units || record.total_units || 0, 10);
    if (totalUnits === 0) continue;

    // Calculate affordable units
    const affordableUnits = [
      'extremely_low_income_units',
      'very_low_income_units',
      'low_income_units',
      'moderate_income_units',
      'middle_income_units',
    ].reduce((sum, field) => sum + parseInt(record[field] || 0, 10), 0);

    const affordableData = {
      affordableUnits,
      affordablePercentage: totalUnits > 0 ? (affordableUnits / totalUnits) * 100 : 0,

      // Income-restricted units
      extremeLowIncomeUnits: parseInt(record.extremely_low_income_units || 0, 10),
      veryLowIncomeUnits: parseInt(record.very_low_income_units || 0, 10),
      lowIncomeUnits: parseInt(record.low_income_units || 0, 10),
      moderateIncomeUnits: parseInt(record.moderate_income_units || 0, 10),
      middleIncomeUnits: parseInt(record.middle_income_units || 0, 10),
      otherIncomeUnits: parseInt(record.other_income_units || 0, 10),

      // Bedroom breakdown
      studioUnits: parseInt(record.studio_units || 0, 10),
      oneBrUnits: parseInt(record['1_br_units'] || 0, 10),
      twoBrUnits: parseInt(record['2_br_units'] || 0, 10),
      threeBrUnits: parseInt(record['3_br_units'] || 0, 10),
      fourBrUnits: parseInt(record['4_br_units'] || 0, 10),
      fiveBrUnits: parseInt(record['5_br_units'] || 0, 10),
      sixBrUnits: parseInt(record['6_br_units'] || 0, 10),
      unknownBrUnits: parseInt(record.unknown_br_units || 0, 10),

      // Housing NY specific
      projectId: record.project_id,
      projectName: record.project_name,
      constructionType: record.reporting_construction_type,
      extendedAffordabilityOnly: record.extended_affordability_only === 'Yes',
    };

    // If multiple Housing NY records for same BBL, keep the one with more affordable units
    if (!affordableMap.has(bbl) || affordableData.affordableUnits > affordableMap.get(bbl).affordableUnits) {
      affordableMap.set(bbl, affordableData);
    }
  }

  console.log(`[Process] Processed ${formatNumber(affordableMap.size)} Housing NY buildings for overlay\n`);
  return affordableMap;
}

/**
 * Overlay Housing NY affordable data onto DCP buildings
 */
function overlayAffordableData(dcpBuildings, housingNyMap) {
  console.log('[Overlay] Overlaying Housing NY affordable data onto DCP buildings...');

  let overlaidCount = 0;

  for (const building of dcpBuildings) {
    if (!building.bbl) continue;

    const affordableData = housingNyMap.get(building.bbl);
    if (affordableData) {
      // Overlay all affordable data
      Object.assign(building, {
        affordableUnits: affordableData.affordableUnits,
        affordablePercentage: affordableData.affordablePercentage,
        extremeLowIncomeUnits: affordableData.extremeLowIncomeUnits,
        veryLowIncomeUnits: affordableData.veryLowIncomeUnits,
        lowIncomeUnits: affordableData.lowIncomeUnits,
        moderateIncomeUnits: affordableData.moderateIncomeUnits,
        middleIncomeUnits: affordableData.middleIncomeUnits,
        otherIncomeUnits: affordableData.otherIncomeUnits,
        studioUnits: affordableData.studioUnits,
        oneBrUnits: affordableData.oneBrUnits,
        twoBrUnits: affordableData.twoBrUnits,
        threeBrUnits: affordableData.threeBrUnits,
        fourBrUnits: affordableData.fourBrUnits,
        fiveBrUnits: affordableData.fiveBrUnits,
        sixBrUnits: affordableData.sixBrUnits,
        unknownBrUnits: affordableData.unknownBrUnits,
        housingNyProjectId: affordableData.projectId,
        housingNyProjectName: affordableData.projectName,
        housingNyConstructionType: affordableData.constructionType,
        housingNyExtendedAffordabilityOnly: affordableData.extendedAffordabilityOnly,
        dataSource: 'dcp-affordable',
        hasAffordableOverlay: true,
      });

      // Update building type to reflect affordable status
      building.buildingType = classifyBuildingType(
        building.totalUnits,
        building.affordableUnits,
        building.jobType,
        true,
        building.buildingClass
      );

      overlaidCount++;
    }
  }

  const totalAffordableUnits = dcpBuildings.reduce((sum, b) => sum + b.affordableUnits, 0);
  const totalUnits = dcpBuildings.reduce((sum, b) => sum + b.totalUnits, 0);
  const affordablePercentage = totalUnits > 0 ? (totalAffordableUnits / totalUnits) * 100 : 0;

  console.log(`[Overlay] Overlaid affordable data on ${formatNumber(overlaidCount)} buildings`);
  console.log(`[Overlay] Total units: ${formatNumber(totalUnits)}`);
  console.log(`[Overlay] Affordable units: ${formatNumber(totalAffordableUnits)} (${affordablePercentage.toFixed(1)}%)\n`);

  return dcpBuildings;
}

/**
 * Deduplicate buildings (same BBL + year = same building)
 * When multiple jobs exist for same BBL+year, keep the one with highest unit count
 */
function deduplicateBuildings(buildings) {
  console.log('[Deduplicate] Removing duplicate buildings (same BBL + year)...');

  const uniqueBuildings = [];
  const duplicateGroups = new Map(); // key: "BBL-year" -> buildings[]

  // Group buildings by BBL + completion year (NOT unit count!)
  for (const building of buildings) {
    // Skip buildings without BBL (can't deduplicate without it)
    if (!building.bbl) {
      uniqueBuildings.push(building);
      continue;
    }

    const key = `${building.bbl}-${building.completionYear}`;

    if (!duplicateGroups.has(key)) {
      duplicateGroups.set(key, []);
    }
    duplicateGroups.get(key).push(building);
  }

  // Process each group
  let deduplicatedCount = 0;
  const deduplicatedExamples = [];

  for (const [key, group] of duplicateGroups.entries()) {
    if (group.length === 1) {
      // No duplicates - keep the only building
      uniqueBuildings.push(group[0]);
    } else {
      // Multiple buildings with same BBL + year -> duplicates
      // Prefer: 1) highest unit count, 2) has affordable overlay, 3) most recent job number
      const bestBuilding = group.reduce((best, current) => {
        // Prefer higher unit count (more complete data)
        if (current.totalUnits > best.totalUnits) return current;
        if (current.totalUnits < best.totalUnits) return best;

        // Same units - prefer affordable overlay
        if (current.hasAffordableOverlay && !best.hasAffordableOverlay) return current;
        if (!current.hasAffordableOverlay && best.hasAffordableOverlay) return best;

        // Same units and overlay status - prefer higher job number (more recent)
        if (current.jobNumber > best.jobNumber) return current;
        return best;
      });

      uniqueBuildings.push(bestBuilding);
      deduplicatedCount += (group.length - 1);

      // Log first few examples
      if (deduplicatedExamples.length < 10) {
        deduplicatedExamples.push({
          bbl: bestBuilding.bbl,
          year: bestBuilding.completionYear,
          duplicateCount: group.length,
          kept: bestBuilding.jobNumber,
          keptUnits: bestBuilding.totalUnits,
          keptAddress: bestBuilding.address,
          allJobs: group.map(b => `${b.jobNumber} (${b.totalUnits} units, ${b.address})`).join(' | ')
        });
      }
    }
  }

  console.log(`[Deduplicate] Original buildings: ${formatNumber(buildings.length)}`);
  console.log(`[Deduplicate] After deduplication: ${formatNumber(uniqueBuildings.length)}`);
  console.log(`[Deduplicate] Removed: ${formatNumber(deduplicatedCount)} duplicate entries`);

  if (deduplicatedExamples.length > 0) {
    console.log(`[Deduplicate] Sample deduplications:`);
    for (const example of deduplicatedExamples) {
      console.log(`  - BBL ${example.bbl}, ${example.year}: ${example.duplicateCount} jobs -> kept ${example.kept} (${example.keptUnits} units, ${example.keptAddress})`);
      if (example.duplicateCount <= 3) {
        console.log(`    All jobs: ${example.allJobs}`);
      }
    }
  }
  console.log('');

  return uniqueBuildings;
}

/**
 * Process DCP demolition records
 */
function processDCPDemolitions(records) {
  console.log('[Process] Processing DCP demolition records...');

  const demolitions = [];
  let skipped = 0;

  for (const record of records) {
    // Only process demolition job types
    if (record.Job_Type !== 'Demolition') continue;

    // Parse completion year
    const completionYear = parseInt(record.CompltYear, 10);
    if (isNaN(completionYear) || completionYear < 2014 || completionYear > 2025) {
      skipped++;
      continue;
    }

    const jobNumber = record.Job_Number || `DCP-DM-${record.OBJECTID}`;
    const bbl = normalizeBBL(record.BBL);
    const borough = BOROUGH_NAMES[record.Boro] || 'Unknown';
    const address = `${record.AddressNum || ''} ${record.AddressSt || ''}`.trim() || 'Address Not Available';

    // Estimate units from ClassAInit (units before demolition) or abs(ClassANet)
    const classAInit = Math.round(Math.abs(parseFloat(record.ClassAInit) || 0));
    const classANet = Math.round(parseFloat(record.ClassANet) || 0);
    const estimatedUnits = classAInit || Math.abs(classANet);

    const demolition = {
      id: jobNumber,
      jobNumber,
      jobType: 'Demolition',
      jobStatus: record.Job_Status || null,
      jobDescription: record.Job_Desc || null,

      bbl,
      borough,
      address,
      latitude: parseFloat(record.Latitude) || null,
      longitude: parseFloat(record.Longitude) || null,

      demolitionYear: completionYear,
      demolitionDate: record.DateComplt ? new Date(record.DateComplt).toISOString() : null,

      classAInit,
      classANet,
      estimatedUnits,
      buildingClass: record.Bldg_Class || null,

      hasNewConstruction: false, // Will be updated in matching step

      lastSyncedAt: new Date(),
    };

    demolitions.push(demolition);
  }

  console.log(`[Process] Processed ${formatNumber(demolitions.length)} DCP demolitions`);
  console.log(`[Process] Skipped ${formatNumber(skipped)} records (invalid years)\n`);
  return demolitions;
}

/**
 * Main seed function
 */
async function main() {
  const t = timer();

  console.log('===================================');
  console.log('   NYC HOUSING DATA SEED SCRIPT   ');
  console.log('   Using DCP Housing Database     ');
  console.log('===================================\n');

  // Initialize database
  const { db, client } = initDb();

  try {
    // Step 1: Fetch DCP Housing Database (new buildings and alterations)
    console.log('--- STEP 1: Fetch DCP Housing Database ---\n');

    // Fetch New Buildings with completed status
    const newBuildingRecords = await fetchArcGISFeatures(DCP_HOUSING_DATABASE_URL, {
      where: "Job_Type = 'New Building' AND CompltYear >= '2014' AND CompltYear <= '2025'",
      orderByFields: 'CompltYear DESC',
      batchSize: 2000,
    });

    // Fetch Alterations with positive net units
    const alterationRecords = await fetchArcGISFeatures(DCP_HOUSING_DATABASE_URL, {
      where: "Job_Type = 'Alteration' AND ClassANet > 0 AND CompltYear >= '2014' AND CompltYear <= '2025'",
      orderByFields: 'CompltYear DESC',
      batchSize: 2000,
    });

    const dcpRecords = [...newBuildingRecords, ...alterationRecords];
    console.log(`[Fetch] Total DCP records: ${formatNumber(dcpRecords.length)}\n`);

    // Step 2: Validate DCP data BEFORE processing
    console.log('--- STEP 2: Validate DCP Housing Data ---\n');
    try {
      // Minimum record count validation (expect at least 10,000 housing records since 2014)
      validateMinimumRecordCount(dcpRecords, 10000, 'DCP Housing Database');

      // Required fields validation
      validateRequiredFields(
        dcpRecords,
        ['Job_Number', 'CompltYear', 'BBL', 'Latitude', 'Longitude', 'ClassANet'],
        'DCP Housing Database',
        50 // Check first 50 records
      );

      // Data type validation
      validateDataTypes(
        dcpRecords,
        {
          Latitude: (val) => validators.isValidLatitude(val),
          Longitude: (val) => validators.isValidLongitude(val),
          CompltYear: (val) => validators.isYearInRange(2014, 2025)(val),
          ClassANet: (val) => validators.isNumber(val),
        },
        'DCP Housing Database',
        50
      );
    } catch (error) {
      logValidationError(error);
      process.exit(1);
    }

    // Step 3: Fetch Housing NY data for affordable overlay
    console.log('--- STEP 3: Fetch Housing NY Data (Affordable Overlay) ---\n');
    const housingNyRecords = await fetchNycOpenData(HOUSING_NY_API, {
      limit: 20000,
      order: 'building_completion_date DESC',
    });

    // Step 3.1: Validate Housing NY data
    console.log('\n--- STEP 3.1: Validate Housing NY Data ---\n');
    try {
      validateMinimumRecordCount(housingNyRecords, 100, 'Housing NY');

      validateRequiredFields(
        housingNyRecords,
        ['bbl', 'building_completion_date', 'all_counted_units'],
        'Housing NY',
        20
      );
    } catch (error) {
      logValidationError(error);
      process.exit(1);
    }

    // Step 4: Fetch DCP demolitions
    console.log('--- STEP 4: Fetch DCP Demolitions ---\n');
    const demolitionRecords = await fetchArcGISFeatures(DCP_HOUSING_DATABASE_URL, {
      where: "Job_Type = 'Demolition' AND CompltYear >= '2014' AND CompltYear <= '2025'",
      orderByFields: 'CompltYear DESC',
      batchSize: 2000,
    });

    // Step 5: Process DCP Housing records
    console.log('--- STEP 4: Process DCP Housing Records ---\n');
    const dcpBuildings = processDCPHousing(dcpRecords);

    // Step 6: Process Housing NY for affordable overlay
    console.log('--- STEP 5: Process Housing NY for Affordable Overlay ---\n');
    const housingNyMap = processHousingNY(housingNyRecords);

    // Step 7: Overlay affordable data
    console.log('--- STEP 6: Overlay Affordable Data ---\n');
    const buildingsWithOverlay = overlayAffordableData(dcpBuildings, housingNyMap);

    // Step 7.5: Deduplicate buildings (same BBL + year + units)
    console.log('--- STEP 6.5: Deduplicate Buildings ---\n');
    const buildings = deduplicateBuildings(buildingsWithOverlay);

    // Step 8: Process demolitions
    console.log('--- STEP 7: Process Demolitions ---\n');
    const demolitions = processDCPDemolitions(demolitionRecords);

    // Step 9: Match demolitions with new construction
    console.log('--- STEP 8: Match Demolitions with New Construction ---\n');
    const buildingBBLs = new Set(buildings.map(b => b.bbl).filter(Boolean));

    for (const demolition of demolitions) {
      if (demolition.bbl && buildingBBLs.has(demolition.bbl)) {
        demolition.hasNewConstruction = true;
      }
    }

    const standaloneDemolitions = demolitions.filter(d => !d.hasNewConstruction);
    console.log(`[Match] ${formatNumber(demolitions.length)} total demolitions`);
    console.log(`[Match] ${formatNumber(standaloneDemolitions.length)} standalone (no new construction)\n`);

    // Step 9: Validate processed data before clearing database
    console.log('--- STEP 9: Validate Processed Data ---\n');
    try {
      validateProcessedRecords(
        buildings,
        [
          (records) => validateMinimumRecordCount(records, 10000, 'Processed Buildings'),
          (records) => {
            // Ensure all buildings have required fields
            const invalid = records.filter(r => !r.id || !r.totalUnits || !r.completionYear);
            if (invalid.length > 0) {
              throw new Error(`${invalid.length} buildings missing required fields`);
            }
          },
        ],
        'Housing Buildings'
      );

      validateProcessedRecords(
        demolitions,
        [
          (records) => {
            // Demolitions can be empty, but if present, should be valid
            if (records.length > 0 && records.some(r => !r.id || !r.demolitionYear)) {
              throw new Error('Some demolitions missing required fields');
            }
          },
        ],
        'Demolitions'
      );
    } catch (error) {
      logValidationError(error);
      process.exit(1);
    }

    // Step 10: Check if data has changed
    console.log('--- STEP 10: Check for Data Changes ---\n');
    const buildingsChangeResult = await detectDataChanges(db, 'housing_buildings', buildings);
    const demolitionsChangeResult = await detectDataChanges(db, 'housing_demolitions', demolitions);

    // Only update if changes detected
    if (!buildingsChangeResult.hasChanges && !demolitionsChangeResult.hasChanges) {
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║          NO CHANGES DETECTED - SKIPPING UPDATE             ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');
      console.log('✓ Housing buildings: No changes');
      console.log('✓ Demolitions: No changes');
      console.log('\n💡 Database is already up to date. Seed skipped to save resources.\n');

      const totalTime = t.stop();
      console.log('===================================');
      console.log('           SEED SUMMARY            ');
      console.log('===================================');
      console.log('Status: SKIPPED (No changes detected)');
      console.log(`Total Time: ${totalTime}`);
      console.log('===================================\n');
      return;
    }

    // Step 11: Clear existing data (only if changes detected)
    console.log('--- STEP 11: Clear Existing Data ---\n');
    console.log('⚠️  Changes detected - clearing tables and inserting new data...\n');

    await clearTable(db, 'housing_buildings', 'housing_buildings');
    await clearTable(db, 'housing_demolitions', 'housing_demolitions');

    // Step 12: Insert into database
    console.log('--- STEP 12: Insert into Database ---\n');
    await batchInsert(db, housingBuildings, buildings, {
      batchSize: 500,
      label: 'housing buildings',
    });

    await batchInsert(db, housingDemolitions, demolitions, {
      batchSize: 500,
      label: 'demolitions',
    });

    // Summary
    const totalUnits = buildings.reduce((sum, b) => sum + b.totalUnits, 0);
    const totalAffordable = buildings.reduce((sum, b) => sum + b.affordableUnits, 0);
    const affordablePercent = totalUnits > 0 ? (totalAffordable / totalUnits) * 100 : 0;

    console.log('===================================');
    console.log('           SEED SUMMARY            ');
    console.log('===================================');
    console.log(`Housing Buildings: ${formatNumber(buildings.length)}`);
    console.log(`  - DCP only: ${formatNumber(buildings.filter(b => b.dataSource === 'dcp').length)}`);
    console.log(`  - DCP + Affordable overlay: ${formatNumber(buildings.filter(b => b.dataSource === 'dcp-affordable').length)}`);
    console.log(`Total Units: ${formatNumber(totalUnits)}`);
    console.log(`Affordable Units: ${formatNumber(totalAffordable)} (${affordablePercent.toFixed(1)}%)`);
    console.log(`Demolitions: ${formatNumber(demolitions.length)}`);
    console.log(`Standalone Demolitions: ${formatNumber(standaloneDemolitions.length)}`);
    console.log(`Total Time: ${t.stop()}`);
    console.log('===================================\n');

  } catch (error) {
    console.error('\n[ERROR] Seed failed:', error);
    process.exit(1);
  } finally {
    await closeDb(client);
  }
}

// Run the seed script
main();
