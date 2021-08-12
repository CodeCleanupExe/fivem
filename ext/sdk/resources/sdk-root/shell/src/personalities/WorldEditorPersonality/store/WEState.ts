import React from 'react';
import { makeAutoObservable, reaction, runInAction } from "mobx";
import { worldEditorApi } from "shared/api.events";
import { onApiMessage, sendApiMessage } from "utils/api";
import { InputController } from "../InputController";
import { onWindowEvent } from 'utils/windowMessages';
import { ShellPersonality, ShellState } from 'store/ShellState';
import { FilesystemEntry } from 'shared/api.types';
import { FXWORLD_FILE_EXT } from 'assets/fxworld/fxworld-types';
import { WorldEditorStartRequest } from 'shared/api.requests';
import {
  WEApplyAdditionChangeRequest,
  WEApplyPatchChangeRequest,
  WECreatePatchRequest,
  WEMap,
  WESelectionType,
  WESetAdditionRequest,
  WESelection,
  WECam,
} from 'backend/world-editor/world-editor-types';
import { WEMapState } from './WEMapState';
import { __DEBUG_MODE_TOGGLES__ } from 'constants/debug-constants';
import { GameState } from 'store/GameState';
import { FlashingMessageState } from '../components/WorldEditorToolbar/FlashingMessage/FlashingMessageState';
import { registerCommandBinding } from '../command-bindings';
import { WECommand, WECommandScope } from '../constants/commands';
import { Events } from './Events';
import { LocalStorageValue } from 'store/generic/LocalStorageValue';
import { WEHistory } from './history/WEHistory';

export enum WEMode {
  EDITOR,
  PLAYTEST,
}

export enum EditorMode {
  TRANSLATE,
  ROTATE,
  SCALE,
}

export const WEState = new class WEState {
  private inputController: InputController;

  public ready = false;

  public mode = WEMode.EDITOR;

  public editorSelect = false;
  public editorMode = EditorMode.TRANSLATE;
  public editorLocal = false;

  public selection: WESelection = { type: WESelectionType.NONE };

  public map: WEMapState | null = null;
  private mapEntry: FilesystemEntry | null = null;

  private introSeen = new LocalStorageValue('we:introSeen', false);

  private forceShowIntro = false;

  get mapName(): string {
    if (this.mapEntry) {
      return this.mapEntry.name.replace(FXWORLD_FILE_EXT, '');
    }

    return '';
  }

  get showIntro(): boolean {
    if (!this.ready) {
      return false;
    }

    if (!this.map) {
      return false;
    }

    if (!this.introSeen.get()) {
      return true;
    }

    return this.forceShowIntro;
  }

  constructor() {
    makeAutoObservable(this);

    if (__DEBUG_MODE_TOGGLES__.WORLD_EDITOR_UI_ONLY) {
      this.ready = true;
    }

    this.bindCommands();
    this.bindEvents();
  }

  private bindEvents() {
    onWindowEvent('we:selection', this.updateSelection);

    onWindowEvent('we:ready', () => runInAction(() => {
      this.ready = true;

      if (!GameState.archetypesCollectionReady) {
        GameState.refreshArchetypesCollection();
      }
    }));

    onWindowEvent('we:createPatch', (request: WECreatePatchRequest) => this.map?.handleCreatePatchRequest(request));
    onWindowEvent('we:setAddition', (request: WESetAdditionRequest) => this.map?.handleSetAdditionRequest(request));
    onWindowEvent('we:applyPatchChange', (request: WEApplyPatchChangeRequest) => this.map?.handleApplyPatchChangeRequest(request));
    onWindowEvent('we:applyAdditionChange', (request: WEApplyAdditionChangeRequest) => this.map?.handleApplyAdditionChangeRequest(request));

    onApiMessage(worldEditorApi.mapLoaded, (map: WEMap) => runInAction(() => {
      this.map = new WEMapState(map);
    }));

    Events.additionDeleted.addListener(({ id }) => {
      if (this.selection.type === WESelectionType.ADDITION && this.selection.id === id) {
        this.clearEditorSelection();
      }
    });
  }

  private bindCommands() {
    registerCommandBinding({
      command: WECommand.CONTROL_COORD_SYSTEM_TOGGLE,
      scope: WECommandScope.EDITOR,
      execute: this.toggleEditorLocal,
    }, { code: 'Backquote' });

    registerCommandBinding({
      command: WECommand.CONTROL_MODE_TRANSLATE_TOGGLE,
      scope: WECommandScope.EDITOR,
      execute: this.enableTranslation,
    }, { code: 'Digit1' });

    registerCommandBinding({
      command: WECommand.CONTROL_MODE_ROTATE_TOGGLE,
      scope: WECommandScope.EDITOR,
      execute: this.enableRotation,
    }, { code: 'Digit2' });

    registerCommandBinding({
      command: WECommand.CONTROL_MODE_SCALE_TOGGLE,
      scope: WECommandScope.EDITOR,
      execute: this.enableScaling,
    }, { code: 'Digit3' });

    registerCommandBinding({
      command: WECommand.CONTROL_CLEAR_SELECTION,
      scope: WECommandScope.EDITOR,
      execute: this.clearEditorSelection,
    }, { code: 'Esc' });

    registerCommandBinding({
      command: WECommand.ACTION_SET_ADDITION_ON_GROUND,
      label: 'Set selected addition on ground',
      configurable: true,
      scope: WECommandScope.EDITOR,
      execute: () => {
        if (this.map && this.selection.type === WESelectionType.ADDITION) {
          this.map.setAdditionOnGround(this.selection.id);
        }
      },
    }, { code: 'KeyS', ctrl: true });

    registerCommandBinding({
      command: WECommand.ACTION_ENTER_PLAYTEST_MODE,
      label: 'Enter play mode',
      configurable: true,
      scope: WECommandScope.EDITOR,
      execute: this.enterPlaytestMode,
    }, { code: 'F5' });
  }

  readonly openIntro = () => {
    this.forceShowIntro = true;
  };

  readonly closeIntro = () => {
    if (!this.introSeen.get()) {
      this.introSeen.set(true);
    }

    this.forceShowIntro = false;
  };

  readonly enterPlaytestMode = () => {
    if (this.mode === WEMode.PLAYTEST) {
      return;
    }

    sendGameClientEvent('we:enterPlaytestMode', '');

    this.mode = WEMode.PLAYTEST;
    this.inputController.enterFullControl();
  };

  readonly enterEditorMode = (relative = false) => {
    if (this.mode === WEMode.EDITOR) {
      return;
    }

    sendGameClientEvent('we:exitPlaytestMode', relative ? 'true' : '');
    this.mode = WEMode.EDITOR;
    this.inputController.exitFullControl();
  };

  readonly enterHotkeyConfigurationMode = () => {
    this.inputController.setScope(WECommandScope.CONFIGURATOR);
  };

  readonly exitHotkeyConfigurationMode = () => {
    this.inputController.setScope(WECommandScope.EDITOR);
  };

  setCam(cam: number[]) {
    sendGameClientEvent('we:setCam', JSON.stringify(cam));
  }

  focusInView(cam: WECam, lookAt: [number, number, number]) {
    sendGameClientEvent('we:focusInView', JSON.stringify({
      cam,
      lookAt,
    }));
  }

  openMap = (entry: FilesystemEntry) => {
    this.map = null;
    this.mapEntry = entry;

    WEHistory.reset();

    sendApiMessage(worldEditorApi.start, {
      mapPath: entry.path,
    } as WorldEditorStartRequest);

    ShellState.setPersonality(ShellPersonality.WORLD_EDITOR);
  };

  closeMap = () => {
    if (false === __DEBUG_MODE_TOGGLES__.WORLD_EDITOR_UI_ONLY) {
      this.ready = false;
    }

    this.map = null;
    this.mapEntry = null;

    sendApiMessage(worldEditorApi.stop);

    ShellState.setPersonality(ShellPersonality.THEIA);
  };

  enableTranslation = () => {
    this.editorMode = EditorMode.TRANSLATE;

    this.updateEditorControls();
  };

  enableRotation = () => {
    this.editorMode = EditorMode.ROTATE;

    this.updateEditorControls();
  };

  enableScaling = () => {
    this.editorMode = EditorMode.SCALE;

    this.updateEditorControls();
  };

  toggleEditorLocal = () => {
    this.editorLocal = !this.editorLocal;

    this.updateEditorControls();
  };

  setEditorSelect = (select: boolean) => {
    this.editorSelect = select;
    Events.gizmoSelectChanged.emit(select);

    this.updateEditorControls();
  };

  isAdditionSelected(additionId: string) {
    if (this.selection.type !== WESelectionType.ADDITION) {
      return false;
    }

    return this.selection.id === additionId;
  }

  isPatchSelected(mapdata: string, entity: string) {
    if (this.selection.type !== WESelectionType.PATCH) {
      return false;
    }

    return this.selection.mapdata === parseInt(mapdata, 10) && this.selection.entity === parseInt(entity, 10);
  }

  readonly setEditorSelection = (selection: WESelection) => {
    this.updateSelection(selection);

    sendGameClientEvent('we:selection', JSON.stringify(selection));
  };

  readonly clearEditorSelection = () => {
    this.setEditorSelection({ type: WESelectionType.NONE });
  };

  createInputController(container: React.RefObject<HTMLDivElement>) {
    this.inputController = new InputController(container, this.setEditorSelect);

    this.inputController.onEscapeFullControl(this.enterEditorMode);

    this.inputController.onCameraMovementBaseMultiplierChange((speed: number) => {
      FlashingMessageState.setMessage(`Camera speed: ${(speed * 100) | 0}%`);
    });
  }

  destroyInputController() {
    this.updateSelection({ type: WESelectionType.NONE });

    if (this.inputController) {
      this.inputController.destroy();
      this.inputController = undefined;
    }
  }

  private updateSelection = (selection: WESelection) => {
    this.selection = selection;
    Events.selectionChanged.emit(selection);
  };

  private updateEditorControls() {
    setWorldEditorControls(this.editorSelect, this.editorMode, this.editorLocal);
  }
};
