import * as Cesium from "cesium";

export interface Zone3DConfig {
    name: string;
    maxRange: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    color: Cesium.Color;
    wallAlpha: number;
    capAlpha: number;
}

export interface Radar3DOptions {
    longitude: number;
    latitude: number;
    antennaMastHeight?: number;
    numAzimuths?: number;
    zones?: Zone3DConfig[];
    showDebugRays?: boolean;
    debugRayLineColor?: Cesium.Color;
}

export class Cesium3DRadarCoverage {

    public static readonly DEFAULT_3D_ZONES: Zone3DConfig[] = [
        {
            name: "Low-Altitude",
            maxRange: 5000,
            minElevationDeg: 0,
            maxElevationDeg: 10,
            color: Cesium.Color.fromCssColorString("#7E22CE"),
            wallAlpha: 0.50,
            capAlpha: 0.25
        },
        {
            name: "Mid-Altitude",
            maxRange: 16000,
            minElevationDeg: 0,
            maxElevationDeg: 20,
            color: Cesium.Color.fromCssColorString("#F59E0B"),
            wallAlpha: 0.50,
            capAlpha: 0.20
        },
        {
            name: "High-Altitude",
            maxRange: 20000,
            minElevationDeg: 0,
            maxElevationDeg: 30,
            color: Cesium.Color.fromCssColorString("#0369A1"),
            wallAlpha: 0.50,
            capAlpha: 0.15
        }
    ];

    private static readonly stepMeters = 10;
    private static readonly ELEVATION_STEP_DEG = 5;

    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: Radar3DOptions
    ): Promise<Cesium.Entity[]> {

        const {
            longitude,
            latitude,
            antennaMastHeight = 0,
            numAzimuths = 144,
            zones = this.DEFAULT_3D_ZONES,
            showDebugRays = false,
            debugRayLineColor =
            Cesium.Color.fromCssColorString("#F5F1E8")
        } = options;

        if (!zones.length) return [];

        const maxOverallRange =
            Math.max(...zones.map(z => z.maxRange));

        const stepsPerRay =
            Math.ceil(maxOverallRange / this.stepMeters);

        const radarCarto =
            Cesium.Cartographic.fromDegrees(
                longitude,
                latitude
            );

        try {
            await Cesium.sampleTerrain(
                terrainProvider,
                11,
                [radarCarto]
            );
        } catch {
            const h =
                viewer.scene.globe.getHeight(radarCarto);

            if (h !== undefined) {
                radarCarto.height = h;
            }
        }

        const groundAltitude = radarCarto.height || 0;
        const radarOriginAlt =
            groundAltitude + antennaMastHeight;

        interface RayEntry {
            azimuthRad: number;
            terrainForRay: number[];
        }

        const computeRayEntries = async (
            azimuthRads: number[]
        ): Promise<RayEntry[]> => {

            const cartographics: Cesium.Cartographic[] = [];

            for (const azimuthRad of azimuthRads) {
                for (let s = 1; s <= stepsPerRay; s++) {

                    const dist = Math.min(
                        s * this.stepMeters,
                        maxOverallRange
                    );

                    const { lon, lat } =
                        this.destinationCoordinate(
                            longitude,
                            latitude,
                            dist,
                            azimuthRad
                        );

                    cartographics.push(
                        Cesium.Cartographic.fromDegrees(
                            lon,
                            lat
                        )
                    );
                }
            }

            try {
                await Cesium.sampleTerrain(
                    terrainProvider,
                    11,
                    cartographics
                );
            } catch {
                try {
                    await Cesium.sampleTerrain(
                        terrainProvider,
                        9,
                        cartographics
                    );
                } catch {
                    for (const c of cartographics) {
                        const h =
                            viewer.scene.globe.getHeight(c);

                        if (h !== undefined) {
                            c.height = h;
                        }
                    }
                }
            }

            const entries: RayEntry[] = [];

            for (
                let a = 0;
                a < azimuthRads.length;
                a++
            ) {

                const start = a * stepsPerRay;
                const raw: number[] = [];

                for (
                    let s = 0;
                    s < stepsPerRay;
                    s++
                ) {
                    raw.push(
                        cartographics[start + s]?.height ??
                        groundAltitude
                    );
                }

                entries.push({
                    azimuthRad: azimuthRads[a],
                    terrainForRay: raw
                });
            }

            return entries;
        };

        const findElevationRayEnd = async (
    ray: RayEntry,
    elevationDeg: number,
    maxRange: number
): Promise<{
    distance: number;
    terrainHeight: number;
    rayHeight: number;
    blocked: boolean;
    blockedBy: "terrain" | "object" | "range";
}> => {

    const elevation =
        Cesium.Math.toRadians(elevationDeg);

    let terrainDistance = maxRange;
    let terrainHeight = groundAltitude;
    let terrainBlocked = false;

    const maxSteps = Math.min(
        stepsPerRay,
        Math.ceil(maxRange / this.stepMeters)
    );

    let previousDiff: number | null = null;
    let previousDist = 0;
    let previousTerrain = groundAltitude;

    for (
        let s = 1;
        s <= maxSteps;
        s++
    ) {

        const dist =
            Math.min(
                s * this.stepMeters,
                maxRange
            );

        const terrain =
            ray.terrainForRay[
                Math.min(
                    ray.terrainForRay.length - 1,
                    s - 1
                )
            ] ?? groundAltitude;

        const rayHeight =
            radarOriginAlt +
            dist * Math.sin(elevation);

        const diff =
            rayHeight - terrain;

        if (
            elevationDeg === 0 &&
            terrain > radarOriginAlt
        ) {

            terrainDistance = dist;
            terrainHeight = terrain;
            terrainBlocked = true;
            break;

        } else if (
            previousDiff !== null &&
            previousDiff > 0 &&
            diff <= 0
        ) {

            const t =
                previousDiff /
                (previousDiff - diff);

            terrainDistance =
                previousDist +
                t * (dist - previousDist);

            terrainHeight =
                previousTerrain +
                t * (terrain - previousTerrain);

            terrainBlocked = true;
            break;
        }

        previousDiff = diff;
        previousDist = dist;
        previousTerrain = terrain;
    }

    if (terrainBlocked) {
        return {
            distance: terrainDistance,
            terrainHeight,
            rayHeight:
                radarOriginAlt +
                terrainDistance *
                Math.sin(elevation),
            blocked: true,
            blockedBy: "terrain"
        };
    }

    return {
        distance: maxRange,
        terrainHeight:
            getRawTerrainAtDist(
                ray,
                maxRange
            ),
        rayHeight:
            radarOriginAlt +
            maxRange *
            Math.sin(elevation),
        blocked: false,
        blockedBy: "range"
    };
};
const baseAzimuths =
    Array.from(
        { length: numAzimuths },
        (_, a) =>
            (a / numAzimuths) *
            Cesium.Math.TWO_PI
    );

const rays =
    await computeRayEntries(
        baseAzimuths
    );

rays.sort(
    (a, b) =>
        a.azimuthRad -
        b.azimuthRad
);

        const createdEntities:
            Cesium.Entity[] = [];

        const getRawTerrainAtDist = (
            ray: RayEntry,
            distance: number
        ) => {

            const idx =
                Math.min(
                    Math.max(
                        1,
                        Math.round(
                            distance /
                            this.stepMeters
                        )
                    ),
                    stepsPerRay
                ) - 1;

            return ray.terrainForRay[idx] ??
                groundAltitude;
        };

        if (showDebugRays) {

            const radarTop =
                Cesium.Cartesian3.fromDegrees(
                    longitude,
                    latitude,
                    radarOriginAlt
                );

            for (const zone of zones) {

                const angles =
                    this.createElevationAngles(
                        zone.maxElevationDeg
                    );

                for (const elevationDeg of angles) {

                    for (const ray of rays) {

                        const result =
                            await findElevationRayEnd(
                                ray,
                                elevationDeg,
                                zone.maxRange
                            );

                        const { lon, lat } =
                            this.destinationCoordinate(
                                longitude,
                                latitude,
                                result.distance,
                                ray.azimuthRad
                            );

                        const height =
                            elevationDeg === 0
                                ? result.terrainHeight
                                : result.blockedBy === "terrain"
                                    ? result.terrainHeight
                                    : result.rayHeight;

                        const end =
                            Cesium.Cartesian3.fromDegrees(
                                lon,
                                lat,
                                height + 5
                            );

                        createdEntities.push(
                            viewer.entities.add({
                                polyline: {
                                    positions: [
                                        radarTop,
                                        end
                                    ],
                                    width: 2,
                                    material:
                                        debugRayLineColor,
                                    clampToGround: false,
                                    depthFailMaterial:
                                        debugRayLineColor
                                }
                            })
                        );
                    }
                }
            }
        }

        for (
            let zIdx = zones.length - 1;
            zIdx >= 0;
            zIdx--
        ) {

            const zone = zones[zIdx];

            const elevationAngles =
                this.createElevationAngles(
                    zone.maxElevationDeg
                );

            interface ElevationRing {
                elevationDeg: number;
                positions: Cesium.Cartesian3[];
                distances: number[];
                blocked: boolean[];
            }

            const rings: ElevationRing[] = [];

            for (
                const elevationDeg of
                elevationAngles
            ) {

                const positions:
                    Cesium.Cartesian3[] = [];

                const distances: number[] = [];
                const blocked: boolean[] = [];

                for (const ray of rays) {

                    const result =
                        await findElevationRayEnd(
                            ray,
                            elevationDeg,
                            zone.maxRange
                        );

                    const distance =
                        result.distance;

                    const { lon, lat } =
                        this.destinationCoordinate(
                            longitude,
                            latitude,
                            distance,
                            ray.azimuthRad
                        );

                    let height: number;

                    if (
                        Math.abs(elevationDeg) <
                        0.0001
                    ) {

                        height =
                            getRawTerrainAtDist(
                                ray,
                                distance
                            );

                    } else if (
                        result.blockedBy ===
                        "terrain"
                    ) {

                        height =
                            result.terrainHeight;

                    } else {

                        height =
                            result.rayHeight;
                    }

                    positions.push(
                        Cesium.Cartesian3.fromDegrees(
                            lon,
                            lat,
                            height
                        )
                    );

                    distances.push(distance);
                    blocked.push(result.blocked);
                }

                if (positions.length) {
                    positions.push(positions[0]);
                }

                rings.push({
                    elevationDeg,
                    positions,
                    distances,
                    blocked
                });
            }

            for (
                let r = 0;
                r < rings.length - 1;
                r++
            ) {

                const lower = rings[r];
                const upper = rings[r + 1];

                for (
                    let i = 0;
                    i < rays.length;
                    i++
                ) {

                    const next =
                        (i + 1) %
                        rays.length;

                    const a =
                        lower.positions[i];

                    const b =
                        lower.positions[next];

                    const c =
                        upper.positions[next];

                    const d =
                        upper.positions[i];

                    if (!a || !b || !c || !d) {
                        continue;
                    }

                    const e1 =
                        viewer.entities.add({
                            polygon: {
                                hierarchy:
                                    new Cesium.PolygonHierarchy([
                                        a,
                                        b,
                                        d
                                    ]),
                                perPositionHeight: true,
                                material:
                                    zone.color.withAlpha(
                                        zone.wallAlpha
                                    ),
                                outline: false
                            }
                        });

                    const e2 =
                        viewer.entities.add({
                            polygon: {
                                hierarchy:
                                    new Cesium.PolygonHierarchy([
                                        b,
                                        c,
                                        d
                                    ]),
                                perPositionHeight: true,
                                material:
                                    zone.color.withAlpha(
                                        zone.wallAlpha
                                    ),
                                outline: false
                            }
                        });

                    createdEntities.push(e1, e2);
                }
            }

            const topRing =
                rings[rings.length - 1];

            if (
                topRing &&
                topRing.positions.length >= 4
            ) {

                createdEntities.push(
                    viewer.entities.add({
                        polygon: {
                            hierarchy:
                                new Cesium.PolygonHierarchy(
                                    topRing.positions
                                ),
                            perPositionHeight: true,
                            material:
                                zone.color.withAlpha(
                                    zone.capAlpha
                                ),
                            outline: true,
                            outlineColor:
                                zone.color.withAlpha(
                                    0.85
                                )
                        }
                    })
                );
            }

            const bottomRing = rings[0];

            if (
                bottomRing &&
                bottomRing.positions.length >= 4
            ) {

                createdEntities.push(
                    viewer.entities.add({
                        polygon: {
                            hierarchy:
                                new Cesium.PolygonHierarchy(
                                    bottomRing.positions
                                ),
                            perPositionHeight: true,
                            material:
                                zone.color.withAlpha(
                                    zone.capAlpha * 0.7
                                ),
                            outline: false
                        }
                    })
                );
            }
        }

        return createdEntities;
    }

    private static createElevationAngles(
        maxElevationDeg: number
    ): number[] {

        const result: number[] = [];

        for (
            let angle = 0;
            angle < maxElevationDeg;
            angle += this.ELEVATION_STEP_DEG
        ) {
            result.push(angle);
        }

        if (
            !result.length ||
            Math.abs(
                result[result.length - 1] -
                maxElevationDeg
            ) > 0.0001
        ) {
            result.push(maxElevationDeg);
        }

        return result;
    }

    private static destinationCoordinate(
        lonDeg: number,
        latDeg: number,
        distMeters: number,
        bearingRad: number
    ): {
        lon: number;
        lat: number;
    } {

        const R = 6378137;
        const d = distMeters / R;

        const lat1 =
            Cesium.Math.toRadians(latDeg);

        const lon1 =
            Cesium.Math.toRadians(lonDeg);

        const lat2 =
            Math.asin(
                Math.sin(lat1) * Math.cos(d) +
                Math.cos(lat1) *
                Math.sin(d) *
                Math.cos(bearingRad)
            );

        const lon2 =
            lon1 +
            Math.atan2(
                Math.sin(bearingRad) *
                Math.sin(d) *
                Math.cos(lat1),
                Math.cos(d) -
                Math.sin(lat1) *
                Math.sin(lat2)
            );

        return {
            lon:
                Cesium.Math.toDegrees(lon2),
            lat:
                Cesium.Math.toDegrees(lat2)
        };
    }
}