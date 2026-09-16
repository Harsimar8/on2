import * as Cesium from "cesium";

/**
 * Cesium exports pickModel at runtime but leaves it out of its typings.
 *
 * It runs real ray/triangle intersection over a model's own indices - the
 * bounding sphere is used only as an early-out - and it transforms every vertex
 * by the model's computed matrix, so scaling a model changes where it blocks.
 * That is what lets a radar ray stop at an object's true silhouette instead of
 * at a sphere drawn around it.
 */
type PickModelFn = (
    model: Cesium.Model,
    ray: Cesium.Ray,
    frameState: unknown,
    verticalExaggeration: number,
    relativeHeight: number,
    ellipsoid: Cesium.Ellipsoid,
    result?: Cesium.Cartesian3
) => Cesium.Cartesian3 | undefined;

const pickModel = (Cesium as unknown as { pickModel?: PickModelFn }).pickModel;

export class CesiumObjectDetector {

    private readonly scratchHit = new Cesium.Cartesian3();

    constructor(private readonly viewer: Cesium.Viewer) { }

    /** True when this build of Cesium exposes precise model picking. */
    static get supportsPrecisePicking(): boolean {
        return typeof pickModel === "function";
    }

    /**
     * Distance along the ray to the nearest glTF/GLB surface, or Infinity if the
     * ray reaches maxDistance without touching one.
     */
    getFirstObjectHit(ray: Cesium.Ray, maxDistance: number): number {

        if (!pickModel) {
            return Number.POSITIVE_INFINITY;
        }

        const scene = this.viewer.scene;
        const primitives = scene.primitives;
        const ellipsoid = scene.ellipsoid ?? Cesium.Ellipsoid.WGS84;

        let nearestDistance = Number.POSITIVE_INFINITY;

        for (let i = 0; i < primitives.length; i++) {

            const primitive = primitives.get(i);

            if (!(primitive instanceof Cesium.Model)) {
                continue;
            }

            const model = primitive as Cesium.Model;

            // A model that has not finished loading has no triangles to test yet.
            if (!model.ready || !model.show) {
                continue;
            }

            const hit = pickModel(
                model,
                ray,
                (scene as unknown as { frameState: unknown }).frameState,
                1.0,
                0.0,
                ellipsoid,
                this.scratchHit
            );

            if (!hit) {
                continue;
            }

            const distance = Cesium.Cartesian3.distance(ray.origin, hit);

            if (distance >= 0 && distance <= maxDistance && distance < nearestDistance) {
                nearestDistance = distance;
            }
        }

        return nearestDistance;
    }
}
