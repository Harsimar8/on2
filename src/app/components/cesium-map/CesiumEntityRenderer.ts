import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from "../../core/models/TeamFilter";
import { Cesium3DRadarCoverage, Radar3DResult, Zone3DConfig } from "./CesiumRadarCoverage";

export class CesiumEntityRenderer {
    private readonly radarEntities = new Map<string, Radar3DResult>();
    private readonly lastBuiltConfig = new Map<string, string>();
    private renderGeneration = 0;

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState
    ) {}

    render(entities: Entity[]): void {
        const myGeneration = ++this.renderGeneration;
        const filter = this.teamFilterService.cesiumFilter();

        this.viewer.entities.removeAll();

        // Clean up radar coverage for any entity that no longer exists
        // (deleted, or filtered out). Primitives live in scene.primitives,
        // not viewer.entities, so removeAll() above does not touch them -
        // this loop is the only place they get cleaned up.
        const currentIds = new Set(entities.map(e => e.id));
        for (const [id, result] of this.radarEntities) {
            if (!currentIds.has(id)) {
                for (const primitive of result.zonePrimitives.values()) {
                    this.viewer.scene.primitives.remove(primitive);
                }
                for (const ent of result.debugEntities) {
                    this.viewer.entities.remove(ent);
                }
                this.radarEntities.delete(id);
                this.lastBuiltConfig.delete(id);
            }
        }

        for (const entity of entities) {
            if (
                (filter === TeamFilter.Blue && entity.team !== Team.Blue) ||
                (filter === TeamFilter.Red && entity.team !== Team.Red)
            ) {
                continue;
            }

            this.drawRadar(entity);
            this.drawTeamDot(entity);

            if (entity.definition.entityType === "RadarSite") {
                this.drawTerrainRadarCone(entity, myGeneration);
            }
        }

        this.viewer.scene.requestRender();
    }

    // Merges each zone's user-set overrides (range/elevation angles) on
    // top of the built-in defaults. A zone with no override just uses the
    // default untouched.
    private buildZoneConfigs(props: Record<string, unknown> | undefined): Zone3DConfig[] {
        const zoneRanges = (props?.['zoneRanges'] as Record<string, number>) ?? {};
        const zoneElevations = (props?.['zoneElevations'] as Record<string, { min: number; max: number }>) ?? {};

        return Cesium3DRadarCoverage.DEFAULT_3D_ZONES.map(zone => ({
            ...zone,
            maxRange: zoneRanges[zone.name] ?? zone.maxRange,
            minElevationDeg: zoneElevations[zone.name]?.min ?? zone.minElevationDeg,
            maxElevationDeg: zoneElevations[zone.name]?.max ?? zone.maxElevationDeg
        }));
    }

    private async drawTerrainRadarCone(entity: Entity, myGeneration: number): Promise<void> {
        const props = entity.definition.properties as Record<string, unknown> | undefined;

        const antennaMastHeight = (props?.['antennaMastHeight'] as number) ?? 25;
        const sectorStartDeg = (props?.['sectorStartDeg'] as number) ?? 0;
        const sectorSweepDeg = (props?.['sectorSweepDeg'] as number) ?? 360;
        const zoneVisibility = (props?.['zoneVisibility'] as Record<string, boolean>) ?? {};
        const zones = this.buildZoneConfigs(props);

        // Everything that affects GEOMETRY goes in this key. If it hasn't
        // changed, we skip re-sampling terrain entirely and just reuse the
        // last built mesh - only visibility gets re-applied cheaply below.
        const configKey = JSON.stringify({
            lon: entity.position.longitude,
            lat: entity.position.latitude,
            antennaMastHeight,
            sectorStartDeg,
            sectorSweepDeg,
            zones: zones.map(z => ({ n: z.name, r: z.maxRange, mn: z.minElevationDeg, mx: z.maxElevationDeg }))
        });

        const lastKey = this.lastBuiltConfig.get(entity.id);
        const cached = this.radarEntities.get(entity.id);

        if (lastKey === configKey && cached) {
            for (const [zoneName, primitive] of cached.zonePrimitives) {
                if (!this.viewer.scene.primitives.contains(primitive)) {
                    this.viewer.scene.primitives.add(primitive);
                }
                primitive.show = zoneVisibility[zoneName] ?? true;
            }
            for (const ent of cached.debugEntities) {
                if (!this.viewer.entities.contains(ent)) this.viewer.entities.add(ent);
            }
            this.viewer.scene.requestRender();
            return;
        }

        // Geometry actually changed - tear down the old mesh before
        // rebuilding, so edits don't pile up duplicate primitives.
        if (cached) {
            for (const primitive of cached.zonePrimitives.values()) {
                this.viewer.scene.primitives.remove(primitive);
            }
            for (const ent of cached.debugEntities) {
                this.viewer.entities.remove(ent);
            }
        }

        try {
            const result = await Cesium3DRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    longitude: entity.position.longitude,
                    latitude: entity.position.latitude,
                    antennaMastHeight,
                    numAzimuths: 72,
                    sectorStartDeg,
                    sectorSweepDeg,
                    elevationRaysPerZone: 5,
                    showDebugRays: false,
                    zones
                }
            );

            if (myGeneration !== this.renderGeneration) {
                for (const primitive of result.zonePrimitives.values()) {
                    this.viewer.scene.primitives.remove(primitive);
                }
                for (const ent of result.debugEntities) {
                    this.viewer.entities.remove(ent);
                }
                return;
            }

            for (const [zoneName, primitive] of result.zonePrimitives) {
                primitive.show = zoneVisibility[zoneName] ?? true;
            }

            this.radarEntities.set(entity.id, result);
            this.lastBuiltConfig.set(entity.id, configKey);

            this.viewer.scene.requestRender();
        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        }
    }

    private drawRadar(entity: Entity): void {
        const selected = this.editorState.selectedEntity()?.id === entity.id;

        this.viewer.entities.add({
            id: entity.id,
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),
            billboard: {
                image: EntityIconFactory.get(entity.definition.entityType),
                width: selected ? 36 : 32,
                height: selected ? 36 : 32,
                scale: selected ? 1.08 : 1.0,
                color: selected
                    ? Cesium.Color.fromCssColorString("#FFF8DC")
                    : Cesium.Color.WHITE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER
            }
        });
    }

    private drawTeamDot(entity: Entity): void {
        this.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),
            billboard: {
                image: entity.team === "Blue" ? "assets/blue.png" : "assets/red.png",
                color: entity.team === "Blue"
                    ? Cesium.Color.fromCssColorString("#3B82F6")
                    : Cesium.Color.WHITE,
                width: 16,
                height: 16,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }
}