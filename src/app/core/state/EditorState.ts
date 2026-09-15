import { Injectable, signal,computed } from '@angular/core';
import { ViewMode } from '../models/ViewMode';
import { AssetDefinition } from '../models/AssetDefinition';
import { Entity } from '../models/Entity';
import { Team } from '../types/Team';

@Injectable({
  providedIn: 'root'
})
export class EditorState {
 
  readonly selectedAsset = signal<AssetDefinition | null>(null);
  

  readonly placementMode = computed(() => {
 
  return this.selectedAsset() !== null;

});
   
  readonly selectedEntity = signal<Entity | null>(null);

  readonly selectedTeam = signal<Team>(Team.Blue);

   readonly viewMode = signal<ViewMode>(ViewMode.ThreeD);

  

}