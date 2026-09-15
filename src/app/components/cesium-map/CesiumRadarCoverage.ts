import * as Cesium from "cesium";
import { CesiumObjectDetector } from "./CesiumObjectDetector";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;          // antenna mast height above terrain (m)
    sectorStartDeg?: number;      // azimuth sector start, 0 = north, clockwise
    sectorSweepDeg?: number;      // 360 = full circle
    drawRays?: boolean;           // overlay the raw sampling rays (debug view)
    azimuthStepDeg?: number;      // wall vertex density (default 10deg -> 36 pts/360)
    rangeSampleSteps?: number;    // distance samples per ray while ray-marching (default 20)
    elevationRingsPerZone?: number; // how many elevation rings sampled per zone (default 4, min 2)
    debugRayStepDeg?: number;     // ray overlay azimuth stride (default 20deg)
    debugRingCount?: number;      // ray overlay elevation rings drawn (default 3)
    useObjectPicking?: boolean;   // also test rays against loaded 3D Tiles/models (default false - this
    // is the expensive part; terrain-only is already accurate and much faster)
    zoneOverrides?: Record<string, RadarZoneOverride>;
}

export interface RadarZoneOverride {
    visible?: boolean;
    range?: number;
    minElevationDeg?: number;
    maxElevationDeg?: number;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
    defaultRange: number;
    defaultMinElevationDeg: number;
    defaultMaxElevationDeg: number;
}

interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
}

interface RayBlockResult {
    distance: number;
    point: Cesium.Cartesian3;
    blocked: boolean;
}

/** Everything create3DRadarZones() built for one radar, so callers can clean up later. */
export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// CesiumRadarCoverage
// =============================================================================

export class CesiumRadarCoverage {

    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        {
            name: "Zone 1 (Low)",
            cssColor: "#22c55e",
            color: Cesium.Color.fromCssColorString("#22c55e"),
            defaultRange: 5000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 10
        },
        {
            name: "Zone 2 (Mid)",
            cssColor: "#f59e0b",
            color: Cesium.Color.fromCssColorString("#f59e0b"),
            defaultRange: 16000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 20
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#3b82f6",
            color: Cesium.Color.fromCssColorString("#3b82f6"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        }
    ];

    // -------------------------------------------------------------------
    // Public entry point
    // -------------------------------------------------------------------

    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {

        const {
            longitude,
            latitude,
            mastHeight = 0,
            sectorStartDeg = 0,
            sectorSweepDeg = 360,
            drawRays = false,
            azimuthStepDeg = 20,
            rangeSampleSteps = 200,
            elevationRingsPerZone = 4,
            debugRayStepDeg = 20,
            debugRingCount = 3,
            useObjectPicking = false,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // ---------------------------------------------------------------
        // 1. Radar base position (terrain sampling - authoritative)
        // ---------------------------------------------------------------

        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;

        const radarPosition = Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            terrainHeight + mastHeight
        );

        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // ---------------------------------------------------------------
        // 2. Radar marker
        // ---------------------------------------------------------------

        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 18,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // ---------------------------------------------------------------
        // 3. Azimuth list (respects sector start/sweep)
        // ---------------------------------------------------------------

        const isFullCircle = sectorSweepDeg >= 360;
        const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
            sectorStartDeg,
            sectorSweepDeg,
            azimuthStepDeg
        );

        // Object picking (scene.pickFromRay against 3D Tiles/models) is opt-in.
        // It's the single most expensive part of a rebuild - one real scene
        // intersection query per sampled ray - and when depthTestAgainstTerrain
        // is enabled (it is, in cesium-map.ts) it will also intersect terrain
        // tiles at whatever LOD is currently loaded near the camera, which is
        // inconsistent and usually coarser than sampleTerrainMostDetailed. That
        // mismatch is what produced the "blade" artifacts even over flat ground.
        // Terrain blocking is always handled by the authoritative terrain sampler
        // below regardless of this flag; enable useObjectPicking only if you
        // actually have loaded 3D Tiles/buildings you want radar to see.
        const objectsToExclude: any[] = useObjectPicking && viewer.scene.globe ? [viewer.scene.globe] : [];

        // ---------------------------------------------------------------
        // 4. Build each zone
        // ---------------------------------------------------------------

        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {

            const override = zoneOverrides[zoneConfig.name] ?? {};
            const visible = override.visible ?? true;

            if (!visible) {
                continue;
            }

            const zone: ResolvedZone = {
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg
            };

            const elevationRingsDeg = CesiumRadarCoverage.buildElevationRings(
                zone.minElevationDeg,
                zone.maxElevationDeg,
                elevationRingsPerZone
            );

            // One grid of real ray-hit points (ring x azimuth). Everything below -
            // the fill mesh, the wireframe, the ground footprint, and the optional
            // debug ray overlay - is built from this SAME grid, so they can never
            // disagree with each other again.
            const grid = await CesiumRadarCoverage.buildZoneGrid(
                viewer,
                terrainProvider,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                elevationRingsDeg,
                rangeSampleSteps,
                useObjectPicking,
                objectsToExclude
            );

            const meshPrimitive = CesiumRadarCoverage.buildMeshPrimitive(
                zone,
                grid.points,
                azimuthsDeg,
                isFullCircle,
                radarPosition
            );
            if (meshPrimitive) {
                viewer.scene.primitives.add(meshPrimitive);
            }

            const wireframePrimitive = CesiumRadarCoverage.buildWireframePrimitive(zone, grid.points, azimuthsDeg, isFullCircle);
            if (wireframePrimitive) {
                viewer.scene.primitives.add(wireframePrimitive);
            }

            const footprintEntity = CesiumRadarCoverage.buildGroundFootprint(viewer, zone, grid.points[0]);

            let rayCollection: Cesium.PolylineCollection | null = null;
            if (drawRays) {
                rayCollection = CesiumRadarCoverage.buildDebugRayCollection(
                    viewer,
                    radarPosition,
                    zone,
                    grid.points,
                    azimuthsDeg,
                    elevationRingsDeg,
                    azimuthStepDeg,
                    debugRayStepDeg,
                    debugRingCount
                );
            }

            handles.push({
                dispose: () => {
                    if (meshPrimitive) viewer.scene.primitives.remove(meshPrimitive);
                    if (wireframePrimitive) viewer.scene.primitives.remove(wireframePrimitive);
                    if (footprintEntity) viewer.entities.remove(footprintEntity);
                    if (rayCollection) viewer.scene.primitives.remove(rayCollection);
                }
            });

            viewer.scene.requestRender();
        }

        return handles;
    }

    // -------------------------------------------------------------------
    // Grid sampling: one elevation ring per row, one azimuth per column.
    // Rings are cast in parallel (independent async calls).
    // -------------------------------------------------------------------

    private static async buildZoneGrid(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        elevationRingsDeg: number[],
        rangeSteps: number,
        useObjectPicking: boolean,
        objectsToExclude: any[]
    ): Promise<{ points: Cesium.Cartesian3[][]; blocked: boolean[][] }> {

        const ringPromises = elevationRingsDeg.map(elevationDeg => {
            const rays = azimuthsDeg.map(az =>
                CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, az, elevationDeg)
            );

            if (elevationDeg === elevationRingsDeg[0]) {
                const ray = rays[0];

                console.log("========== RADAR → F16 TEST ==========");
                console.log("Ray origin:", ray.origin);
                console.log("Ray direction:", ray.direction);

                const primitives = viewer.scene.primitives;

                for (let i = 0; i < primitives.length; i++) {
                    const primitive = primitives.get(i);

                    if (!(primitive instanceof Cesium.Model)) {
                        continue;
                    }

                    const model = primitive as Cesium.Model;

                    if (!model.ready) {
                        continue;
                    }

                    const intersection = Cesium.IntersectionTests.raySphere(
                        ray,
                        model.boundingSphere
                    );

                    console.log("F16 intersection:", intersection);

                    if (intersection) {
                        console.log(
                            "✅ RADAR RAY HIT F16 at:",
                            intersection.stop,
                            "meters"
                        );
                    } else {
                        console.log("❌ RADAR RAY DID NOT HIT F16");
                    }
                }

                console.log("=======================================");
            }
            return CesiumRadarCoverage.castRaysBlockDistances(
                viewer, terrainProvider, radarPosition, rays, zone.range, rangeSteps, useObjectPicking, objectsToExclude
            );
        });

        const ringResults = await Promise.all(ringPromises);

        return {
            points: ringResults.map(rs => rs.map(r => r.point)),
            blocked: ringResults.map(rs => rs.map(r => r.blocked))
        };
    }

    // -------------------------------------------------------------------
    // Filled coverage mesh: a real triangle mesh through the ring x azimuth
    // grid of ray-hit points, so obstacles at any sampled elevation (not
    // just the top/bottom of the zone) show up as an inward dip exactly
    // where they occur.
    // -------------------------------------------------------------------

    private static buildMeshPrimitive(
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        azimuthsDeg: number[],
        isFullCircle: boolean,
        radarPosition: Cesium.Cartesian3
    ): Cesium.Primitive | null {

        const ringCount = points.length;
        const azCount = azimuthsDeg.length;

        if (ringCount < 2 || azCount < 2) {
            return null;
        }

        const indexOf = (ring: number, az: number) => ring * azCount + az;

        const positionValues: number[] = [];
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azCount; a++) {
                const p = points[r][a];
                positionValues.push(p.x, p.y, p.z);
            }
        }

        const indices: number[] = [];
        const azStepCount = isFullCircle ? azCount : azCount - 1;

        for (let r = 0; r < ringCount - 1; r++) {
            for (let a = 0; a < azStepCount; a++) {
                const aNext = (a + 1) % azCount;

                const i00 = indexOf(r, a);
                const i01 = indexOf(r, aNext);
                const i10 = indexOf(r + 1, a);
                const i11 = indexOf(r + 1, aNext);

                const d00 = Cesium.Cartesian3.distance(radarPosition, points[r][a]);
                const d01 = Cesium.Cartesian3.distance(radarPosition, points[r][aNext]);
                const d10 = Cesium.Cartesian3.distance(radarPosition, points[r + 1][a]);
                const d11 = Cesium.Cartesian3.distance(radarPosition, points[r + 1][aNext]);

                const maxDistance = Math.max(d00, d01, d10, d11);
                const minDistance = Math.min(d00, d01, d10, d11);

                // Do not create a stretched triangle across a terrain blockage.


                indices.push(i00, i10, i11);
                indices.push(i00, i11, i01);
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const meshAttributes = new Cesium.GeometryAttributes();
        meshAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: meshAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(0.28))
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                closed: false
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Wireframe overlay: circumferential ring lines + radial ribs through
    // the same grid, drawn in an opaque, slightly stronger version of the
    // zone color. This is what makes the terracing (the actual precision
    // you asked for) visually readable even when "Draw 3D Rays" is off.
    // -------------------------------------------------------------------

    private static buildWireframePrimitive(
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        azimuthsDeg: number[],
        isFullCircle: boolean
    ): Cesium.Primitive | null {

        const ringCount = points.length;
        const azCount = azimuthsDeg.length;

        if (ringCount < 1 || azCount < 2) {
            return null;
        }

        const indexOf = (ring: number, az: number) => ring * azCount + az;

        const positionValues: number[] = [];
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azCount; a++) {
                const p = points[r][a];
                positionValues.push(p.x, p.y, p.z);
            }
        }

        const indices: number[] = [];
        const azStepCount = isFullCircle ? azCount : azCount - 1;

        // circumferential ring lines
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azStepCount; a++) {
                const aNext = (a + 1) % azCount;
                indices.push(indexOf(r, a), indexOf(r, aNext));
            }
        }

        // radial ribs (ring-to-ring, per azimuth)
        for (let a = 0; a < azCount; a++) {
            for (let r = 0; r < ringCount - 1; r++) {
                indices.push(indexOf(r, a), indexOf(r + 1, a));
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const wireAttributes = new Cesium.GeometryAttributes();
        wireAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: wireAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.LINES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(0.85))
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    lineWidth: 1,
                    depthTest: { enabled: true }
                }
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Ground footprint: a shaded fill on the ground (same color as the
    // wall, lower alpha) so the coverage area reads clearly from a
    // top-down / low-zoom view too.
    // -------------------------------------------------------------------

    private static buildGroundFootprint(
        viewer: Cesium.Viewer,
        zone: ResolvedZone,
        ring0Points: Cesium.Cartesian3[]
    ): Cesium.Entity | null {

        if (!ring0Points || ring0Points.length < 3) {
            return null;
        }

        const hierarchy = ring0Points.map(p => {
            const c = Cesium.Cartographic.fromCartesian(p);
            // small vertical lift to avoid z-fighting with the terrain mesh
            return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + 0.5);
        });

        return viewer.entities.add({
            name: `${zone.name} ground footprint`,
            polygon: {
                hierarchy,
                perPositionHeight: true,
                material: zone.color.withAlpha(0.15),
                outline: true,
                outlineColor: zone.color.withAlpha(0.6)
            }
        });
    }

    // -------------------------------------------------------------------
    // Optional debug ray overlay (toggle: "Draw 3D Rays"). Reuses the same
    // grid as the wall/mesh so the rays land exactly on the wall surface
    // instead of a separately-sampled (and therefore misaligned) fan.
    // -------------------------------------------------------------------

    private static buildDebugRayCollection(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        azimuthsDeg: number[],
        elevationRingsDeg: number[],
        azimuthStepDeg: number,
        debugRayStepDeg: number,
        debugRingCount: number
    ): Cesium.PolylineCollection {

        const collection = new Cesium.PolylineCollection();

        const azStride = Math.max(1, Math.round(debugRayStepDeg / Math.max(1, azimuthStepDeg)));
        const ringStride = Math.max(1, Math.round(elevationRingsDeg.length / Math.max(1, debugRingCount)));

        for (let r = 0; r < elevationRingsDeg.length; r += ringStride) {
            for (let a = 0; a < azimuthsDeg.length; a += azStride) {
                collection.add({
                    positions: [radarPosition, points[r][a]],
                    width: 1,
                    material: Cesium.Material.fromType("Color", {
                        color: zone.color.withAlpha(0.55)
                    })
                });
            }
        }

        viewer.scene.primitives.add(collection);
        return collection;
    }

    // -------------------------------------------------------------------
    // Core: batched terrain sampling + object (glTF / 3D Tiles) picking,
    // combined per ray. Terrain sampling stays the primary/authoritative
    // check; pickFromRay only adds detection for built objects that sit
    // above the terrain mesh - the globe itself is explicitly excluded
    // from picking so it can never contradict the terrain sampler.
    // -------------------------------------------------------------------

    // A ray that's fully blocked right at the radar still renders as this
    // fraction of the zone's range, so it reads as "wall shrinks to almost
    // nothing here" instead of "wall vanishes / you can see straight through".


    private static async castRaysBlockDistances(


        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        origin: Cesium.Cartesian3,
        rays: Cesium.Ray[],
        maxDistance: number,
        steps: number,
        useObjectPicking: boolean,
        objectsToExclude: any[] = []
    ): Promise<RayBlockResult[]> {

        const objectDetector = new CesiumObjectDetector(viewer);

        // --- 1. Terrain: one batched sampleTerrainMostDetailed call for ALL rays ---
        //         Sample index 0 per ray is distance 0 (the radar's own position),
        //         so blocking right at the mast is captured instead of being
        //         skipped over by the first real step.

        const samplesPerRay = steps + 1;

        const flatCartographics: Cesium.Cartographic[] = [];
        const flatPoints: Cesium.Cartesian3[] = [];
        const flatDistances: number[] = [];

        for (const ray of rays) {
            for (let step = 0; step <= steps; step++) {
                const distance = (maxDistance / steps) * step;
                const point = Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3());
                flatPoints.push(point);
                flatDistances.push(distance);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampledTerrain = await Cesium.sampleTerrainMostDetailed(terrainProvider, flatCartographics);

        const terrainDistances: number[] = rays.map(() => maxDistance);

        for (let r = 0; r < rays.length; r++) {

            let previousDistance = 0;
            let previousBlocked = false;

            for (let step = 1; step <= steps; step++) {

                const idx = r * samplesPerRay + step;

                const groundHeight = sampledTerrain[idx].height ?? 0;
                const rayHeight =
                    Cesium.Cartographic.fromCartesian(flatPoints[idx]).height;

                const blocked = groundHeight >= rayHeight;

                if (blocked) {

                    const currentDistance = flatDistances[idx];

                    // Refine the blockage location between
                    // previousDistance and currentDistance.
                    let low = previousDistance;
                    let high = currentDistance;

                    for (let i = 0; i < 9; i++) {

                        const mid = (low + high) / 2;

                        const midPoint = Cesium.Ray.getPoint(
                            rays[r],
                            mid,
                            new Cesium.Cartesian3()
                        );

                        const midCartographic =
                            Cesium.Cartographic.fromCartesian(midPoint);

                        const [terrainSample] =
                            await Cesium.sampleTerrainMostDetailed(
                                terrainProvider,
                                [midCartographic]
                            );

                        const midGroundHeight =
                            terrainSample.height ?? 0;

                        if (midGroundHeight >= midCartographic.height) {
                            high = mid;
                        } else {
                            low = mid;
                        }
                    }

                    terrainDistances[r] = high;
                    break;
                }

                previousDistance = flatDistances[idx];
                previousBlocked = blocked;
            }
        }

        // --- 2. Objects: check loaded GLB models using their bounding spheres ---
const results: RayBlockResult[] = [];

for (let r = 0; r < rays.length; r++) {

    const detectedObjectDistance =
        objectDetector.getFirstObjectHit(rays[r]);

    const objectDistance = Math.min(
        detectedObjectDistance,
        maxDistance
    );

    const rawDistance = Math.min(
        terrainDistances[r],
        objectDistance,
        maxDistance
    );

    const blocked = rawDistance < maxDistance - 1e-6;

    const point = Cesium.Ray.getPoint(
        rays[r],
        rawDistance,
        new Cesium.Cartesian3()
    );

    results.push({
        distance: rawDistance,
        point,
        blocked
    });
}
            
            // Clamp only the point used for rendering, never the "blocked" flag
            // or the reported distance - so a genuinely-blocked ray still shows
            // as a thin sliver of wall instead of collapsing onto the radar dot.

            

        return results;
    }

    // -------------------------------------------------------------------
    // Geometry helpers
    // -------------------------------------------------------------------

    private static makeRay(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthDeg: number,
        elevationDeg: number
    ): Cesium.Ray {

        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const elevation = Cesium.Math.toRadians(elevationDeg);

        const localDirection = new Cesium.Cartesian3(
            Math.sin(azimuth) * Math.cos(elevation),
            Math.cos(azimuth) * Math.cos(elevation),
            Math.sin(elevation)
        );

        const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(
            enuMatrix,
            localDirection,
            new Cesium.Cartesian3()
        );

        Cesium.Cartesian3.normalize(worldDirection, worldDirection);

        return new Cesium.Ray(radarPosition, worldDirection);
    }

    private static buildAzimuthList(
        sectorStartDeg: number,
        sectorSweepDeg: number,
        stepDeg: number
    ): number[] {

        const sweep = Cesium.Math.clamp(sectorSweepDeg, 1, 360);
        const step = Math.max(1, stepDeg);
        const count = Math.max(2, Math.round(sweep / step) + (sweep >= 360 ? 0 : 1));

        const azimuths: number[] = [];

        for (let i = 0; i < count; i++) {
            const raw = sectorStartDeg + (sweep * i) / (sweep >= 360 ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }

        return azimuths;
    }

    private static buildElevationRings(
        minDeg: number,
        maxDeg: number,
        ringCount: number
    ): number[] {

        const count = Math.max(2, Math.round(ringCount));

        if (maxDeg <= minDeg) {
            return [minDeg];
        }

        const rings: number[] = [];
        for (let i = 0; i < count; i++) {
            rings.push(minDeg + ((maxDeg - minDeg) * i) / (count - 1));
        }

        return rings;
    }
}