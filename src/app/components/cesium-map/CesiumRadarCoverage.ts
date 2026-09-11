// import * as Cesium from "cesium";

// export interface Zone3DConfig {
//     name: string;
//     maxRange: number;       // Max range in meters
//     ceilingHeight: number;  // Ceiling above radar ground in meters
//     color: Cesium.Color;
//     wallAlpha: number;
//     capAlpha: number;
// }

// export interface Radar3DOptions {
//     longitude: number;
//     latitude: number;
//     antennaMastHeight?: number; // Height of antenna above ground (e.g. 25m)
//     numAzimuths?: number;       // Number of azimuth rays (72 = every 5 degrees)
//     zones?: Zone3DConfig[];
// }

// export class Cesium3DRadarCoverage {
//     public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
//         {
//             name: "Low-Altitude (Plum)",
//             maxRange: 5000,
//             ceilingHeight: 400, // 400m ceiling
//             color: Cesium.Color.fromCssColorString("#7E22CE"),
//             wallAlpha: 0.35,
//             capAlpha: 0.25
//         },
//         {
//             name: "Mid-Altitude (Amber)",
//             maxRange: 16000, // widened from 12000 per request
//             ceilingHeight: 900, // 900m ceiling
//             color: Cesium.Color.fromCssColorString("#F59E0B"),
//             wallAlpha: 0.30,
//             capAlpha: 0.20
//         },
//         {
//             name: "High-Altitude (Cobalt)",
//             maxRange: 20000,
//             ceilingHeight: 1600, // 1600m ceiling
//             color: Cesium.Color.fromCssColorString("#0369A1"),
//             wallAlpha: 0.25,
//             capAlpha: 0.15
//         }
//     ];

//     // Maximum allowed line-of-sight obstruction angle (radians).
//     // tan(60 deg) ~= 1.73. Without this cap, one nearby ridge can force
//     // the "shadow floor" to climb without bound at long range, which was
//     // pushing wall tops above the ceiling and causing spikes on the horizon.
//     private static readonly MAX_SLOPE = 1.73;

//     /**
//      * Builds true 3D volumetric radar cylinders with realistic 3D radar shadow.
//      * Behind a mountain, the cylinder bottom FLOATS in the air and never touches the valley bed!
//      */
//     static async create3DRadarZones(
//         viewer: Cesium.Viewer,
//         terrainProvider: Cesium.TerrainProvider,
//         options: Radar3DOptions
//     ): Promise<Cesium.Entity[]> {
//         const {
//             longitude,
//             latitude,
//             antennaMastHeight = 25,
//             numAzimuths = 144, // finer resolution -> smoother, less blocky circle
//             zones = this.DEFAULT_3D_ZONES
//         } = options;

//         const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
//         const stepMeters = 250;
//         const stepsPerRay = Math.ceil(maxOverallRange / stepMeters);

//         // 1. Collect points for terrain query
//         const cartographics: Cesium.Cartographic[] = [];
//         const radarCenter = Cesium.Cartographic.fromDegrees(longitude, latitude);
//         cartographics.push(radarCenter);

//         for (let a = 0; a < numAzimuths; a++) {
//             const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;

//             for (let s = 1; s <= stepsPerRay; s++) {
//                 const dist = Math.min(s * stepMeters, maxOverallRange);
//                 const { lon, lat } = this.destinationCoordinate(longitude, latitude, dist, azimuthRad);
//                 cartographics.push(Cesium.Cartographic.fromDegrees(lon, lat));
//             }
//         }

//         // Fast, camera-independent terrain sampling
//         try {
//             await Cesium.sampleTerrain(terrainProvider, 11, cartographics);
//         } catch {
//             try {
//                 await Cesium.sampleTerrain(terrainProvider, 9, cartographics);
//             } catch {
//                 for (const c of cartographics) {
//                     const h = viewer.scene.globe.getHeight(c);
//                     if (h !== undefined) c.height = h;
//                 }
//             }
//         }

//         const groundAltitude = cartographics[0].height || 0;
//         const radarOriginAlt = groundAltitude + antennaMastHeight;

//         // 2. Line of Sight (LOS) and 3D Shadow Line calculation
//         // For each ray, compute the shadow height profile along distance
//         interface AzimuthProfile {
//             // Obstacle distance per zone (where ceiling is hit)
//             zoneEndDists: number[];
//             // Shadow elevation at the end of each zone
//             zoneShadowHeights: number[];
//             // Terrain elevation at the end of each zone
//             zoneTerrainHeights: number[];
//         }

//         const profiles: AzimuthProfile[] = [];

//         // Moving-average window (in samples) used to smooth raw terrain
//         // heights before they feed the slope/shadow calculation. Real DEM
//         // data has small noise/bumps of a few meters between sample points;
//         // without smoothing, a single noisy sample can permanently distort
//         // the "shadow line" for the rest of that ray (since maxSlope only
//         // ever increases), producing sharp fake notches even on flat ground.
//         const SMOOTH_WINDOW = 3;

//         for (let a = 0; a < numAzimuths; a++) {
//             const rayStartIndex = 1 + a * stepsPerRay;

//             // Raw terrain heights for this ray, pulled once up front so we
//             // can smooth them before the slope/shadow pass below.
//             const rawTerrainForRay: number[] = [];
//             for (let s = 1; s <= stepsPerRay; s++) {
//                 const sample = cartographics[rayStartIndex + s - 1];
//                 rawTerrainForRay.push(sample?.height ?? groundAltitude);
//             }

//             // Simple centered moving average to suppress single-sample noise.
//             const smoothedTerrainForRay: number[] = rawTerrainForRay.map((_, i) => {
//                 const lo = Math.max(0, i - Math.floor(SMOOTH_WINDOW / 2));
//                 const hi = Math.min(rawTerrainForRay.length - 1, i + Math.floor(SMOOTH_WINDOW / 2));
//                 let sum = 0;
//                 for (let k = lo; k <= hi; k++) sum += rawTerrainForRay[k];
//                 return sum / (hi - lo + 1);
//             });

//             let maxSlope = -Infinity;
//             let greenEndDist = zones[0].maxRange;
//             let yellowEndDist = zones[1].maxRange;
//             let redEndDist = zones[2].maxRange;

//             let greenHit = false;
//             let yellowHit = false;
//             let redHit = false;

//             const shadowHeightAtDist: number[] = [];
//             const terrainHeightAtDist: number[] = [];

//             for (let s = 1; s <= stepsPerRay; s++) {
//                 const dist = Math.min(s * stepMeters, maxOverallRange);
//                 // Use the smoothed height for slope/shadow math (reduces
//                 // false positives), but keep the raw height available too
//                 // since the actual wall geometry should still hug real terrain.
//                 const terrainH = smoothedTerrainForRay[s - 1];

//                 terrainHeightAtDist.push(terrainH);

//                 // Earth curvature drop
//                 const earthDrop = (dist * dist) / (2 * 6378137);

//                 // Slope from antenna to this terrain point
//                 const slope = (terrainH + earthDrop - radarOriginAlt) / dist;
//                 if (slope > maxSlope) {
//                     maxSlope = slope;
//                 }

//                 // FIX: cap the running max slope so distant shadow heights
//                 // can't run away to infinity from one nearby steep ridge.
//                 if (maxSlope > this.MAX_SLOPE) {
//                     maxSlope = this.MAX_SLOPE;
//                 }

//                 // Minimum visible height at this distance (the 3D shadow line)
//                 const shadowAlt = radarOriginAlt + dist * maxSlope - earthDrop;
//                 shadowHeightAtDist.push(shadowAlt);

//                 // Check Green Zone (400m ceiling)
//                 const greenCeilingAbs = groundAltitude + zones[0].ceilingHeight - earthDrop;
//                 if (!greenHit && (terrainH >= greenCeilingAbs || shadowAlt >= greenCeilingAbs)) {
//                     greenEndDist = dist;
//                     greenHit = true;
//                 }

//                 // Check Yellow Zone (900m ceiling)
//                 const yellowCeilingAbs = groundAltitude + zones[1].ceilingHeight - earthDrop;
//                 if (!yellowHit && (terrainH >= yellowCeilingAbs || shadowAlt >= yellowCeilingAbs)) {
//                     yellowEndDist = dist;
//                     yellowHit = true;
//                 }

//                 // Check Red Zone (1600m ceiling)
//                 const redCeilingAbs = groundAltitude + zones[2].ceilingHeight - earthDrop;
//                 if (!redHit && (terrainH >= redCeilingAbs || shadowAlt >= redCeilingAbs)) {
//                     redEndDist = dist;
//                     redHit = true;
//                 }
//             }

//             // FIX: a zone's boundary must never extend past its own configured
//             // maxRange, no matter what the terrain does farther out. Previously
//             // the hit-scan ran all the way to maxOverallRange (e.g. 20000m) for
//             // EVERY zone's check, so on gently-rising "flat looking" ground the
//             // green zone's 400m ceiling might not be crossed until 12000m+ out,
//             // stretching a green tongue far past its own ring and straight
//             // through mountains in between (and across yellow's boundary).
//             greenEndDist = Math.min(greenEndDist, zones[0].maxRange);
//             yellowEndDist = Math.min(yellowEndDist, zones[1].maxRange);
//             redEndDist = Math.min(redEndDist, zones[2].maxRange);

//             // Get shadow & terrain height at the effective boundary of each zone
//             const getHeightsAtDist = (targetDist: number) => {
//                 const idx = Math.min(Math.max(1, Math.round(targetDist / stepMeters)), stepsPerRay) - 1;
//                 return {
//                     shadowH: shadowHeightAtDist[idx] ?? groundAltitude,
//                     terrainH: terrainHeightAtDist[idx] ?? groundAltitude
//                 };
//             };

//             const gH = getHeightsAtDist(greenEndDist);
//             const yH = getHeightsAtDist(yellowEndDist);
//             const rH = getHeightsAtDist(redEndDist);

//             profiles.push({
//                 zoneEndDists: [greenEndDist, yellowEndDist, redEndDist],
//                 zoneShadowHeights: [gH.shadowH, yH.shadowH, rH.shadowH],
//                 zoneTerrainHeights: [gH.terrainH, yH.terrainH, rH.terrainH]
//             });
//         }

//         const createdEntities: Cesium.Entity[] = [];

//         // 3. Build the 3D Cylinders with FLOATING bottoms
//         for (let zIdx = zones.length - 1; zIdx >= 0; zIdx--) {
//             const zone = zones[zIdx];
//             const ceilingAltitude = groundAltitude + zone.ceilingHeight;

//             const wallTopCartesians: Cesium.Cartesian3[] = [];
//             const wallBottomHeights: number[] = [];
//             const capCartesians: Cesium.Cartesian3[] = [];

//             for (let a = 0; a < numAzimuths; a++) {
//                 const azimuthRad = (a / numAzimuths) * Cesium.Math.TWO_PI;
//                 const profile = profiles[a];

//                 const effectiveDist = profile.zoneEndDists[zIdx];
//                 const shadowAlt = profile.zoneShadowHeights[zIdx];
//                 const terrainAlt = profile.zoneTerrainHeights[zIdx];

//                 const { lon, lat } = this.destinationCoordinate(
//                     longitude,
//                     latitude,
//                     effectiveDist,
//                     azimuthRad
//                 );

//                 // The bottom of the wall FLOATS at shadowAlt if a mountain blocked the lower rays.
//                 // It never drops down below the actual terrain either.
//                 const floatingBottom = Math.max(terrainAlt, shadowAlt);

//                 // FIX: the wall top must ALWAYS sit exactly at the ceiling —
//                 // never let floatingBottom push it higher. Previously this was
//                 // Math.max(ceilingAltitude, floatingBottom + 5), which let the
//                 // top shoot above the ceiling and produced spikes above ridgelines.
//                 const safeTopHeight = ceilingAltitude;
//                 const safeBottomHeight = Math.min(floatingBottom, safeTopHeight - 2);

//                 const topPos = Cesium.Cartesian3.fromDegrees(lon, lat, safeTopHeight);
//                 wallTopCartesians.push(topPos);
//                 wallBottomHeights.push(safeBottomHeight);

//                 capCartesians.push(topPos);
//             }

//             // Close wall loop
//             wallTopCartesians.push(wallTopCartesians[0]);
//             wallBottomHeights.push(wallBottomHeights[0]);

//             // A. 3D Vertical Curtain Wall
//             // In open areas: Touches the ground.
//             // Behind mountains: FLOATS high in the sky at the shadow line,
//             // but its top is always flush with the flat ceiling cap.
//             const wallEntity = viewer.entities.add({
//                 name: `${zone.name} 3D Wall`,
//                 wall: {
//                     positions: wallTopCartesians,
//                     minimumHeights: wallBottomHeights,
//                     material: zone.color.withAlpha(zone.wallAlpha),
//                     outline: true,
//                     outlineColor: zone.color.withAlpha(0.9),
//                     outlineWidth: 2
//                 }
//             });
//             createdEntities.push(wallEntity);

//             // B. 3D Flat Top Ceiling Cap
//             const capEntity = viewer.entities.add({
//                 name: `${zone.name} Top Cap`,
//                 polygon: {
//                     hierarchy: new Cesium.PolygonHierarchy(capCartesians),
//                     height: ceilingAltitude,
//                     material: zone.color.withAlpha(zone.capAlpha),
//                     outline: true,
//                     outlineColor: zone.color.withAlpha(0.85)
//                 }
//             });
//             createdEntities.push(capEntity);
//         }

//         return createdEntities;
//     }

//     private static destinationCoordinate(
//         lonDeg: number,
//         latDeg: number,
//         distMeters: number,
//         bearingRad: number
//     ): { lon: number; lat: number } {
//         const R = 6378137.0;
//         const dByR = distMeters / R;
//         const lat1 = Cesium.Math.toRadians(latDeg);
//         const lon1 = Cesium.Math.toRadians(lonDeg);

//         const lat2 = Math.asin(
//             Math.sin(lat1) * Math.cos(dByR) +
//             Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearingRad)
//         );

//         const lon2 = lon1 + Math.atan2(
//             Math.sin(bearingRad) * Math.sin(dByR) * Math.cos(lat1),
//             Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
//         );

//         return {
//             lon: Cesium.Math.toDegrees(lon2),
//             lat: Cesium.Math.toDegrees(lat2)
//         };
//     }
// }


import * as Cesium from "cesium";

export interface Zone3DConfig {
    name: string;
    maxRange: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    color: Cesium.Color;
    alpha: number;
}

export interface Radar3DOptions {
    longitude: number;
    latitude: number;
    antennaMastHeight?: number;
    numAzimuths?: number;
    zones?: Zone3DConfig[];
    sectorStartDeg?: number;
    sectorSweepDeg?: number;
    elevationRaysPerZone?: number;
    showDebugRays?: boolean;
    debugRayLineColor?: Cesium.Color;
}

export interface Radar3DResult {
    zonePrimitives: Map<string, Cesium.Primitive>;
    debugEntities: Cesium.Entity[];
}

export class Cesium3DRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
    {
        name: "Low-Altitude (Green)",
        maxRange: 5000,
        minElevationDeg: 0,
        maxElevationDeg: 2,
        color: Cesium.Color.fromCssColorString("#7E22CE"),
        alpha: 0.55
    },
    {
        name: "Mid-Altitude (Yellow)",
        maxRange: 16000,
        minElevationDeg: 2,
        maxElevationDeg: 5,
        color: Cesium.Color.fromCssColorString("#F59E0B"),
        alpha: 0.50
    },
    {
        name: "High-Altitude (Red/Pink)",
        maxRange: 20000,
        minElevationDeg: 5,
        maxElevationDeg: 10,
        color: Cesium.Color.fromCssColorString("#0369A1"),
        alpha: 0.45
    }
];

    private static readonly JUMP_HEIGHT_THRESHOLD_M = 120;
    private static readonly MIN_ANGULAR_GAP_RAD = Cesium.Math.toRadians(0.02);
    private static readonly MAX_REFINE_ROUNDS = 6;
    private static readonly MAX_TOTAL_RAYS = 2000;
    private static readonly SMOOTH_WINDOW = 3;
    private static readonly stepMeters = 10;

    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: Radar3DOptions
    ): Promise<Radar3DResult> {
        const {
            longitude,
            latitude,
            antennaMastHeight = 0,
            numAzimuths = 72,
            zones = this.DEFAULT_3D_ZONES,
            sectorStartDeg = 0,
            sectorSweepDeg = 360,
            elevationRaysPerZone = 5,
            showDebugRays = false,
            debugRayLineColor = Cesium.Color.fromCssColorString("#F5F1E8")
        } = options;

        const maxOverallRange = Math.max(...zones.map(z => z.maxRange));
        const stepsPerRay = Math.ceil(maxOverallRange / this.stepMeters);
        const isFullCircle = sectorSweepDeg >= 360;

        const radarCarto = Cesium.Cartographic.fromDegrees(longitude, latitude);
        try {
            await Cesium.sampleTerrain(terrainProvider, 11, [radarCarto]);
        } catch {
            const h = viewer.scene.globe.getHeight(radarCarto);
            if (h !== undefined) radarCarto.height = h;
        }
        const groundAltitude = radarCarto.height || 0;
        const radarOriginAlt = groundAltitude + antennaMastHeight;

        interface RayEntry {
            azimuthRad: number;
            rawTerrain: number[];
            smoothedTerrain: number[];
        }

        const computeRayEntries = async (azimuthRads: number[]): Promise<RayEntry[]> => {
            const cartographics: Cesium.Cartographic[] = [];
            for (const azimuthRad of azimuthRads) {
                for (let s = 1; s <= stepsPerRay; s++) {
                    const dist = Math.min(s * this.stepMeters, maxOverallRange);
                    const { lon, lat } = this.destinationCoordinate(longitude, latitude, dist, azimuthRad);
                    cartographics.push(Cesium.Cartographic.fromDegrees(lon, lat));
                }
            }

            try {
                await Cesium.sampleTerrain(terrainProvider, 11, cartographics);
            } catch {
                try {
                    await Cesium.sampleTerrain(terrainProvider, 9, cartographics);
                } catch {
                    for (const c of cartographics) {
                        const h = viewer.scene.globe.getHeight(c);
                        if (h !== undefined) c.height = h;
                    }
                }
            }

            const entries: RayEntry[] = [];
            for (let a = 0; a < azimuthRads.length; a++) {
                const rayStart = a * stepsPerRay;
                const raw: number[] = [];
                for (let s = 0; s < stepsPerRay; s++) {
                    raw.push(cartographics[rayStart + s]?.height ?? groundAltitude);
                }
                const smoothed: number[] = raw.map((_, i) => {
                    const lo = Math.max(0, i - Math.floor(this.SMOOTH_WINDOW / 2));
                    const hi = Math.min(raw.length - 1, i + Math.floor(this.SMOOTH_WINDOW / 2));
                    let sum = 0;
                    for (let k = lo; k <= hi; k++) sum += raw[k];
                    return sum / (hi - lo + 1);
                });
                entries.push({ azimuthRad: azimuthRads[a], rawTerrain: raw, smoothedTerrain: smoothed });
            }
            return entries;
        };

        const peakHeight = (r: RayEntry): number => Math.max(...r.smoothedTerrain);

        const startRad = Cesium.Math.toRadians(sectorStartDeg);
        const sweepRad = Cesium.Math.toRadians(Math.min(sectorSweepDeg, 360));
        const baseAzimuths = Array.from({ length: numAzimuths }, (_, a) =>
            isFullCircle
                ? (a / numAzimuths) * Cesium.Math.TWO_PI
                : startRad + (a / Math.max(1, numAzimuths - 1)) * sweepRad
        );

        let rays: RayEntry[] = await computeRayEntries(baseAzimuths);
        rays.sort((a, b) => a.azimuthRad - b.azimuthRad);

        for (let round = 0; round < this.MAX_REFINE_ROUNDS; round++) {
            if (rays.length >= this.MAX_TOTAL_RAYS) break;

            const midpointAzimuths: number[] = [];
            const insertAfterIndex: number[] = [];

            for (let i = 0; i < rays.length; i++) {
                if (!isFullCircle && i === rays.length - 1) continue;

                const cur = rays[i];
                const next = rays[(i + 1) % rays.length];

                let angularGap = next.azimuthRad - cur.azimuthRad;
                if (angularGap <= 0) angularGap += Cesium.Math.TWO_PI;
                if (angularGap <= this.MIN_ANGULAR_GAP_RAD) continue;

                const heightJump = Math.abs(peakHeight(cur) - peakHeight(next));
                if (heightJump > this.JUMP_HEIGHT_THRESHOLD_M) {
                    const midAz = (cur.azimuthRad + angularGap / 2) % Cesium.Math.TWO_PI;
                    midpointAzimuths.push(midAz);
                    insertAfterIndex.push(i);
                }
            }

            if (midpointAzimuths.length === 0) break;
            const room = this.MAX_TOTAL_RAYS - rays.length;
            if (room <= 0) break;

            const azimuthsToSample = midpointAzimuths.slice(0, room);
            const indicesToUse = insertAfterIndex.slice(0, room);
            const newEntries = await computeRayEntries(azimuthsToSample);

            const combined = indicesToUse.map((idx, k) => ({ idx, entry: newEntries[k] }));
            combined.sort((a, b) => b.idx - a.idx);
            for (const { idx, entry } of combined) rays.splice(idx + 1, 0, entry);
        }

        const R_EARTH = 6378137;
        const castBeam = (ray: RayEntry, elevationRad: number, maxDist: number) => {
            const maxSteps = Math.min(stepsPerRay, Math.floor(maxDist / this.stepMeters));
            for (let s = 1; s <= maxSteps; s++) {
                const dist = s * this.stepMeters;
                const terrainH = ray.smoothedTerrain[s - 1];
                const earthDrop = (dist * dist) / (2 * R_EARTH);
                const beamH = radarOriginAlt + dist * Math.tan(elevationRad);
                if (terrainH + earthDrop >= beamH) {
                    return { dist, height: ray.rawTerrain[s - 1], blocked: true };
                }
            }
            const beamHAtMax = radarOriginAlt + maxDist * Math.tan(elevationRad);
            return { dist: maxDist, height: beamHAtMax, blocked: false };
        };

        const zonePrimitives = new Map<string, Cesium.Primitive>();
        const debugEntities: Cesium.Entity[] = [];

        if (showDebugRays) {
            const radarTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarOriginAlt);
            for (const ray of rays) {
                const endHeight = ray.rawTerrain[ray.rawTerrain.length - 1];
                const { lon, lat } = this.destinationCoordinate(longitude, latitude, maxOverallRange, ray.azimuthRad);
                const endPos = Cesium.Cartesian3.fromDegrees(lon, lat, endHeight + 15);
                const lineEntity = viewer.entities.add({
                    polyline: {
                        positions: [radarTop, endPos],
                        width: 2,
                        material: debugRayLineColor,
                        clampToGround: false,
                        depthFailMaterial: debugRayLineColor
                    }
                });
                debugEntities.push(lineEntity);
            }
        }

        for (const zone of zones) {
            const nAz = rays.length;
            const nEl = Math.max(2, elevationRaysPerZone);
            const minElRad = Cesium.Math.toRadians(zone.minElevationDeg);
            const maxElRad = Cesium.Math.toRadians(zone.maxElevationDeg);

            const grid: Cesium.Cartesian3[][] = [];
            for (let i = 0; i < nAz; i++) {
                const ray = rays[i];
                const row: Cesium.Cartesian3[] = [];
                for (let j = 0; j < nEl; j++) {
                    const elevRad = minElRad + (j / (nEl - 1)) * (maxElRad - minElRad);
                    const { dist, height } = castBeam(ray, elevRad, zone.maxRange);
                    const { lon, lat } = this.destinationCoordinate(longitude, latitude, dist, ray.azimuthRad);
                    row.push(Cesium.Cartesian3.fromDegrees(lon, lat, height));
                }
                grid.push(row);
            }

            const positions: number[] = [];
            const indices: number[] = [];
            const flatIndex = (i: number, j: number) => i * nEl + j;

            for (let i = 0; i < nAz; i++) {
                for (let j = 0; j < nEl; j++) {
                    positions.push(grid[i][j].x, grid[i][j].y, grid[i][j].z);
                }
            }

            const azSpan = isFullCircle ? nAz : nAz - 1;
            for (let i = 0; i < azSpan; i++) {
                const iNext = (i + 1) % nAz;
                for (let j = 0; j < nEl - 1; j++) {
                    const a = flatIndex(i, j);
                    const b = flatIndex(iNext, j);
                    const c = flatIndex(iNext, j + 1);
                    const d = flatIndex(i, j + 1);
                    indices.push(a, b, c, a, c, d);
                }
            }

            if (indices.length === 0) continue;

            const geometry = new Cesium.Geometry({
    attributes: {
        position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positions)
        })
    } as Cesium.GeometryAttributes,
    indices: new Uint32Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions)
});

            const instance = new Cesium.GeometryInstance({
                geometry: geometry,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                        zone.color.withAlpha(zone.alpha)
                    )
                }
            });

            const primitive = new Cesium.Primitive({
    geometryInstances: instance,
    appearance: new Cesium.PerInstanceColorAppearance({
        translucent: true,
        closed: false,
        flat: true,
        renderState: {
            depthTest: { enabled: true },
            depthMask: false,
            blending: Cesium.BlendingState.ALPHA_BLEND
        }
    }),
    asynchronous: false
});

            viewer.scene.primitives.add(primitive);
            zonePrimitives.set(zone.name, primitive);
        }

        return { zonePrimitives, debugEntities };
    }

    private static destinationCoordinate(
        lonDeg: number,
        latDeg: number,
        distMeters: number,
        bearingRad: number
    ): { lon: number; lat: number } {
        const R = 6378137.0;
        const dByR = distMeters / R;
        const lat1 = Cesium.Math.toRadians(latDeg);
        const lon1 = Cesium.Math.toRadians(lonDeg);

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(dByR) +
            Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearingRad)
        );

        const lon2 = lon1 + Math.atan2(
            Math.sin(bearingRad) * Math.sin(dByR) * Math.cos(lat1),
            Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
        );

        return {
            lon: Cesium.Math.toDegrees(lon2),
            lat: Cesium.Math.toDegrees(lat2)
        };
    }
}