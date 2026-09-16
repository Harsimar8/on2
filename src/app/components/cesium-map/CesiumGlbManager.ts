import * as Cesium from "cesium";

export interface PlacedGlb {
    id: string;
    name: string;
    model: Cesium.Model;
    longitude: number;
    latitude: number;
    heightAboveGround: number;
    scale: number;
    /** Object URL to revoke on removal, for models loaded from a local file. */
    objectUrl?: string;
}

/**
 * Loads GLB models into the scene so they can be used as radar obstacles, and
 * keeps their placement editable (height above ground, scale).
 *
 * Radar coverage is rebuilt through the onChange callback rather than from here,
 * so this class stays unaware of radars.
 */
export class CesiumGlbManager {

    private readonly placed: PlacedGlb[] = [];
    private nextId = 1;

    constructor(
        private readonly viewer: Cesium.Viewer,
        private readonly terrainProvider: Cesium.TerrainProvider,
        private readonly onChange: () => void
    ) { }

    list(): PlacedGlb[] {
        return this.placed;
    }

    /** Loads a GLB the user picked in the browser and drops it at the view centre. */
    async addFromFile(file: File, heightAboveGround: number, scale: number): Promise<void> {

        const objectUrl = URL.createObjectURL(file);

        try {
            await this.add(file.name, objectUrl, heightAboveGround, scale, objectUrl);
        } catch (err) {
            URL.revokeObjectURL(objectUrl);
            throw err;
        }
    }

    /** Loads a GLB from a URL (e.g. one of the bundled assets). */
    async addFromUrl(name: string, url: string, heightAboveGround: number, scale: number): Promise<void> {
        await this.add(name, url, heightAboveGround, scale);
    }

    private async add(
        name: string,
        url: string,
        heightAboveGround: number,
        scale: number,
        objectUrl?: string
    ): Promise<void> {

        const centre = this.viewCentreCartographic();

        const [ground] = await Cesium.sampleTerrainMostDetailed(
            this.terrainProvider,
            [Cesium.Cartographic.fromRadians(centre.longitude, centre.latitude)]
        );

        const longitude = Cesium.Math.toDegrees(centre.longitude);
        const latitude = Cesium.Math.toDegrees(centre.latitude);

        const model = await Cesium.Model.fromGltfAsync({
            url,
            scale,
            // Without this, reading the model's vertices back for triangle
            // picking fails on a WebGL1 context.
            enablePick: true,
            modelMatrix: CesiumGlbManager.modelMatrixFor(
                longitude,
                latitude,
                (ground.height ?? 0) + heightAboveGround
            )
        });

        this.viewer.scene.primitives.add(model);

        const placed: PlacedGlb = {
            id: `glb-${this.nextId++}`,
            name,
            model,
            longitude,
            latitude,
            heightAboveGround,
            scale,
            objectUrl
        };

        this.placed.push(placed);

        // The model only gains its triangles once it has been through a render
        // pass, so coverage is rebuilt after it is genuinely pickable.
        this.rebuildWhenReady(model);
    }

    setScale(id: string, scale: number): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        placed.scale = Math.max(0.01, scale);
        placed.model.scale = placed.scale;

        this.rebuildAfterNextFrame();
    }

    setHeight(id: string, heightAboveGround: number): void {

        const placed = this.find(id);

        if (!placed) {
            return;
        }

        placed.heightAboveGround = heightAboveGround;
        this.reposition(placed);
    }

    remove(id: string): void {

        const index = this.placed.findIndex(p => p.id === id);

        if (index === -1) {
            return;
        }

        const [placed] = this.placed.splice(index, 1);

        this.viewer.scene.primitives.remove(placed.model);

        if (placed.objectUrl) {
            URL.revokeObjectURL(placed.objectUrl);
        }

        this.rebuildAfterNextFrame();
    }

    private async reposition(placed: PlacedGlb): Promise<void> {

        const [ground] = await Cesium.sampleTerrainMostDetailed(
            this.terrainProvider,
            [Cesium.Cartographic.fromDegrees(placed.longitude, placed.latitude)]
        );

        placed.model.modelMatrix = CesiumGlbManager.modelMatrixFor(
            placed.longitude,
            placed.latitude,
            (ground.height ?? 0) + placed.heightAboveGround
        );

        this.rebuildAfterNextFrame();
    }

    private find(id: string): PlacedGlb | undefined {
        return this.placed.find(p => p.id === id);
    }

    private static modelMatrixFor(
        longitude: number,
        latitude: number,
        height: number
    ): Cesium.Matrix4 {

        return Cesium.Transforms.eastNorthUpToFixedFrame(
            Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
        );
    }

    /** Ground point at the centre of the current view, falling back to the camera. */
    private viewCentreCartographic(): Cesium.Cartographic {

        const scene = this.viewer.scene;

        const centre = new Cesium.Cartesian2(
            scene.canvas.clientWidth / 2,
            scene.canvas.clientHeight / 2
        );

        const ray = this.viewer.camera.getPickRay(centre);
        const position = ray ? scene.globe.pick(ray, scene) : undefined;

        return position
            ? Cesium.Cartographic.fromCartesian(position)
            : this.viewer.camera.positionCartographic;
    }

    private rebuildWhenReady(model: Cesium.Model): void {

        if (model.ready) {
            this.rebuildAfterNextFrame();
            return;
        }

        const listener = () => {
            model.readyEvent.removeEventListener(listener);
            this.rebuildAfterNextFrame();
        };

        model.readyEvent.addEventListener(listener);
        this.viewer.scene.requestRender();
    }

    /**
     * A model's picking transform is recomputed during its render pass, so a
     * rebuild triggered before the next frame would still intersect the old
     * size/position.
     */
    private rebuildAfterNextFrame(): void {

        const scene = this.viewer.scene;

        const listener = () => {
            scene.postRender.removeEventListener(listener);
            this.onChange();
        };

        scene.postRender.addEventListener(listener);
        scene.requestRender();
    }
}
