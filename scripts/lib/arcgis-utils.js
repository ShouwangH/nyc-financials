// ABOUTME: Utilities for fetching data from ArcGIS REST API services
// ABOUTME: Handles pagination and data transformation from ArcGIS Feature Services

/**
 * Fetch all features from an ArcGIS Feature Service with pagination
 *
 * @param {string} serviceUrl - Base URL of the ArcGIS Feature Service (e.g., .../FeatureServer/0)
 * @param {Object} options - Query options
 * @param {string} options.where - SQL where clause (default: '1=1' for all records)
 * @param {string} options.outFields - Fields to return (default: '*' for all)
 * @param {number} options.batchSize - Records per request (default: 2000)
 * @param {string} options.orderByFields - Sort order (default: none)
 * @returns {Promise<Array>} Array of feature attributes (without geometry by default)
 */
export async function fetchArcGISFeatures(serviceUrl, options = {}) {
  const {
    where = '1=1',
    outFields = '*',
    batchSize = 2000,
    orderByFields = null,
    includeGeometry = false,
  } = options;

  const features = [];
  let offset = 0;
  let hasMore = true;

  console.log(`[ArcGIS] Fetching from: ${serviceUrl}`);
  console.log(`[ArcGIS] Where: ${where}\n`);

  while (hasMore) {
    const params = new URLSearchParams({
      where,
      outFields,
      resultRecordCount: batchSize.toString(),
      resultOffset: offset.toString(),
      orderByFields: orderByFields || '',
      returnGeometry: includeGeometry ? 'true' : 'false',
      f: 'json',
    });

    const url = `${serviceUrl}/query?${params}`;

    try {
      console.log(`[ArcGIS] Fetching offset ${offset}...`);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`ArcGIS Error: ${data.error.message}`);
      }

      if (!data.features || data.features.length === 0) {
        hasMore = false;
        break;
      }

      // Extract attributes (and optionally geometry)
      for (const feature of data.features) {
        if (includeGeometry && feature.geometry) {
          features.push({
            ...feature.attributes,
            geometry: feature.geometry,
          });
        } else {
          features.push(feature.attributes);
        }
      }

      console.log(`[ArcGIS] Retrieved ${data.features.length} records (total: ${features.length})`);

      // Check if there are more records
      if (data.features.length < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }

      // Rate limiting - be nice to the API
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.error(`[ArcGIS] Error at offset ${offset}:`, error.message);
      throw error;
    }
  }

  console.log(`[ArcGIS] Completed: ${features.length} total records\n`);
  return features;
}

/**
 * Get count of records matching a where clause
 *
 * @param {string} serviceUrl - Base URL of the ArcGIS Feature Service
 * @param {string} where - SQL where clause (default: '1=1' for all records)
 * @returns {Promise<number>} Count of matching records
 */
export async function getArcGISCount(serviceUrl, where = '1=1') {
  const params = new URLSearchParams({
    where,
    returnCountOnly: 'true',
    f: 'json',
  });

  const url = `${serviceUrl}/query?${params}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      throw new Error(`ArcGIS Error: ${data.error.message}`);
    }

    return data.count || 0;
  } catch (error) {
    console.error('[ArcGIS] Error getting count:', error.message);
    throw error;
  }
}

/**
 * Get metadata about an ArcGIS Feature Service
 *
 * @param {string} serviceUrl - Base URL of the ArcGIS Feature Service
 * @returns {Promise<Object>} Service metadata including fields
 */
export async function getArcGISMetadata(serviceUrl) {
  const url = `${serviceUrl}?f=json`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      throw new Error(`ArcGIS Error: ${data.error.message}`);
    }

    return data;
  } catch (error) {
    console.error('[ArcGIS] Error getting metadata:', error.message);
    throw error;
  }
}
