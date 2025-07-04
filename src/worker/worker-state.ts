/**
 * WorkerState - Quản lý tất cả trạng thái trên worker
 */

import { SipWorker } from '../common/types';

export interface WorkerStateData {
  // SIP Registration State
  sipRegistration: {
    registered: boolean;
    uri?: string;
    username?: string;
    displayName?: string;
    error?: string;
  };

  // Active Calls State
  activeCalls: Map<string, SipWorker.CallInfo>;

  // Tab Media Permissions
  tabPermissions: Map<string, {
    tabId: string;
    mediaPermission: SipWorker.TabMediaPermission;
    lastUpdated: number;
  }>;

  // Worker Info
  workerInfo: {
    startTime: number;
    version: string;
    connectedTabs: number;
  };

  // Transport State
  transport: {
    connected: boolean;
    server?: string;
    error?: string;
  };
}

export class WorkerState {
  private state: WorkerStateData;
  private listeners: Set<(state: WorkerStateData) => void> = new Set();

  constructor() {
    this.state = {
      sipRegistration: {
        registered: false
      },
      activeCalls: new Map(),
      tabPermissions: new Map(),
      workerInfo: {
        startTime: Date.now(),
        version: '1.0.0',
        connectedTabs: 0
      },
      transport: {
        connected: false
      }
    };
  }

  /**
   * Get current state snapshot
   */
  public getState(): WorkerStateData {
    return {
      ...this.state,
      activeCalls: new Map(this.state.activeCalls) // Clone Map
    };
  }

  /**
   * Get serializable state for sending to tabs
   */
  public getSerializableState(): any {
    return {
      sipRegistration: this.state.sipRegistration,
      activeCalls: Array.from(this.state.activeCalls.entries()).map(([callId, info]) => ({ callId, ...info })),
      tabPermissions: Array.from(this.state.tabPermissions.entries()).map(([id, permission]) => ({ id, ...permission })),
      workerInfo: this.state.workerInfo,
      transport: this.state.transport
    };
  }

  /**
   * Update SIP registration state
   */
  public setSipRegistration(registration: Partial<WorkerStateData['sipRegistration']>): void {
    this.state.sipRegistration = {
      ...this.state.sipRegistration,
      ...registration
    };
    this.notifyListeners();
  }

  /**
   * Update or add active call
   */
  public setActiveCall(callId: string, callInfo: SipWorker.CallInfo): void {
    this.state.activeCalls.set(callId, callInfo);
    this.notifyListeners();
  }

  /**
   * Remove active call
   */
  public removeActiveCall(callId: string): void {
    this.state.activeCalls.delete(callId);
    this.notifyListeners();
  }

  /**
   * Get active call
   */
  public getActiveCall(callId: string): SipWorker.CallInfo | undefined {
    return this.state.activeCalls.get(callId);
  }

  /**
   * Get all active calls
   */
  public getActiveCalls(): SipWorker.CallInfo[] {
    return Array.from(this.state.activeCalls.values());
  }

  /**
   * Update transport state
   */
  public setTransport(transport: Partial<WorkerStateData['transport']>): void {
    this.state.transport = {
      ...this.state.transport,
      ...transport
    };
    this.notifyListeners();
  }

  /**
   * Update worker info
   */
  public setWorkerInfo(info: Partial<WorkerStateData['workerInfo']>): void {
    this.state.workerInfo = {
      ...this.state.workerInfo,
      ...info
    };
    this.notifyListeners();
  }

  /**
   * Add state change listener
   */
  public addListener(listener: (state: WorkerStateData) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Remove state change listener
   */
  public removeListener(listener: (state: WorkerStateData) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    const currentState = this.getState();
    this.listeners.forEach(listener => {
      try {
        listener(currentState);
      } catch (error) {
        console.error('Error in state listener:', error);
      }
    });
  }

  /**
   * Update tab media permission
   */
  public setTabPermission(tabId: string, permission: SipWorker.TabMediaPermission): void {
    this.state.tabPermissions.set(tabId, {
      tabId,
      mediaPermission: permission,
      lastUpdated: Date.now()
    });
    this.notifyListeners();
  }

  /**
   * Get tab media permission
   */
  public getTabPermission(tabId: string): SipWorker.TabMediaPermission | undefined {
    return this.state.tabPermissions.get(tabId)?.mediaPermission;
  }

  /**
   * Remove tab permission
   */
  public removeTabPermission(tabId: string): void {
    this.state.tabPermissions.delete(tabId);
    this.notifyListeners();
  }

  /**
   * Clear all state (for cleanup)
   */
  public clear(): void {
    this.state.sipRegistration = { registered: false };
    this.state.activeCalls.clear();
    this.state.tabPermissions.clear();
    this.state.transport = { connected: false };
    this.notifyListeners();
  }
} 