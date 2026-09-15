import * as Cesium from "cesium";

export class CesiumObjectDetector {

    private readonly viewer: Cesium.Viewer;

    constructor(viewer: Cesium.Viewer) {
        this.viewer = viewer;
    }

    /**
     * Finds the nearest GLB/Model hit by a radar ray.
     *
     * Returns:
     *   distance in meters -> object was hit
     *   Infinity           -> nothing was hit
     */
    getFirstObjectHit(ray: Cesium.Ray): number {
  let nearestDistance = Infinity;

  const primitives = this.viewer.scene.primitives;

  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives.get(i);

    if (!(primitive instanceof Cesium.Model)) {
      continue;
    }

    const model = primitive as Cesium.Model;

    if (!model.ready || !model.boundingSphere) {
      continue;
    }

    const intersection = Cesium.IntersectionTests.raySphere(
      ray,
      model.boundingSphere
    );

    if (!intersection) {
      continue;
    }

    const distance =
      intersection.start > 0
        ? intersection.start
        : intersection.stop;

    if (distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
}

    public testObjects(): void {

  const primitives = this.viewer.scene.primitives;

  console.log("========== OBJECTS ==========");

  for (let i = 0; i < primitives.length; i++) {

    const primitive = primitives.get(i);

    console.log(
      "Primitive:",
      i,
      primitive
    );

    if (primitive instanceof Cesium.Model) {
      console.log("✅ GLB MODEL FOUND");
    }
  }

  console.log("=============================");
}

public testF16Sphere(): void {

  const primitives = this.viewer.scene.primitives;

  for (let i = 0; i < primitives.length; i++) {

    const primitive = primitives.get(i);

    if (!(primitive instanceof Cesium.Model)) {
      continue;
    }

    const model = primitive as Cesium.Model;

    const sphere = model.boundingSphere;

    console.log("========== F16 SPHERE ==========");
    console.log("Center:", sphere.center);
    console.log("Radius:", sphere.radius);
    console.log("===============================");
  }
}
}