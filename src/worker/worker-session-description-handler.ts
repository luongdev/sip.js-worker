import { SessionDescriptionHandler as SDHInterface, SessionDescriptionHandlerOptions, SessionDescriptionHandlerModifier, BodyAndContentType } from 'sip.js/lib/api';
import { Logger } from 'sip.js/lib/core';
import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { SipWorker } from '../common/types';
import { WorkerState } from './worker-state';

/**
 * Extended options for WorkerSessionDescriptionHandler
 */
export interface WorkerSessionDescriptionHandlerOptions extends SessionDescriptionHandlerOptions {
  /**
   * Call ID để identify cuộc gọi
   */
  callId: string;
  
  /**
   * Action hiện tại (offer hoặc answer) để biết đường request SDP
   */
  action?: 'offer' | 'answer';
}

/**
 * Custom SessionDescriptionHandler for Worker mode
 * Redirects all media operations to the appropriate tab instead of handling them in worker
 * Supports early media by handling multiple descriptions
 */
export class WorkerSessionDescriptionHandler implements SDHInterface {
  private logger: Logger;
  private messageBroker: MessageBroker;
  private tabManager: TabManager;
  private callId: string;
  private isClosed: boolean = false;
  private isEarlyMedia: boolean = false;
  private selectedTabId?: string;

  constructor(
    logger: Logger,
    messageBroker: MessageBroker,
    tabManager: TabManager,
    callId: string,
    isEarlyMedia: boolean = false,
    private session?: any, // SIP.js session để detect context
    private workerState?: WorkerState // WorkerState để update handlingTabId
  ) {
    this.logger = logger;
    this.messageBroker = messageBroker;
    this.tabManager = tabManager;
    this.callId = callId;
    this.isEarlyMedia = isEarlyMedia;
    
    // Log the callId for debugging
    this.logger.debug(`WorkerSessionDescriptionHandler created with callId: ${this.callId}`);
  }



  /**
   * Close this handler and cleanup resources
   */
  public close(): void {
    this.logger.debug('WorkerSessionDescriptionHandler.close');
    this.isClosed = true;
  }

  /**
   * Get description (offer/answer) from the selected tab
   */
  public async getDescription(
    options?: WorkerSessionDescriptionHandlerOptions,
    modifiers?: Array<SessionDescriptionHandlerModifier>
  ): Promise<BodyAndContentType> {
    this.logger.debug('WorkerSessionDescriptionHandler.getDescription');
    
    // TODO: Implement serialization and handling of SessionDescriptionHandlerOptions and SessionDescriptionHandlerModifiers
    // Need to serialize options/modifiers and send them to tab for proper SDP manipulation
    // Currently ignoring options and modifiers for simplicity
    
    if (this.isClosed) {
      throw new Error('SessionDescriptionHandler is closed');
    }

    // Get the best tab to handle media (use cached tab for consistency)
    let selectedTab;
    if (this.selectedTabId) {
      selectedTab = this.tabManager.getTab(this.selectedTabId);
    }
    
    if (!selectedTab) {
      selectedTab = await this.tabManager.getSelectedTab();
      if (!selectedTab) {
        throw new Error('No tab available for media handling');
      }
      this.selectedTabId = selectedTab.id;
      
      // Update handlingTabId in WorkerState if available
      if (this.workerState) {
        const existingCallInfo = this.workerState.getActiveCall(this.callId);
        if (existingCallInfo) {
          console.log(`WorkerSDH: Setting handlingTabId ${selectedTab.id} for callId ${this.callId}`);
          this.workerState.setActiveCall(this.callId, {
            ...existingCallInfo,
            handlingTabId: selectedTab.id
          });
          
          // Verify it was set
          const updatedCallInfo = this.workerState.getActiveCall(this.callId);
          console.log(`WorkerSDH: Verified handlingTabId for ${this.callId}:`, updatedCallInfo?.handlingTabId);
        } else {
          console.warn(`WorkerSDH: No existing call info found for callId ${this.callId} when trying to set handlingTabId`);
        }
      }
    }

    this.logger.debug(`Requesting SDP offer from tab: ${selectedTab.id} (early media: ${this.isEarlyMedia}, callId: ${this.callId})`);

    // Determine if we need offer or answer based on SIP.js session context
    let requestType: 'offer' | 'answer' = 'offer'; // Default to offer
    
    if (this.session) {
      // Check if this is an incoming call (Invitation) that needs an answer
      // In SIP.js, Invitation.accept() calls getDescription() to create an answer
      const sessionConstructorName = this.session.constructor.name;
      if (sessionConstructorName === 'Invitation') {
        requestType = 'answer';
        this.logger.debug(`Detected Invitation session, requesting answer`);
      } else {
        this.logger.debug(`Detected ${sessionConstructorName} session, requesting offer`);
      }
    }
    
    // Send media request to tab
    const mediaRequest: SipWorker.MediaRequest = {
      callId: this.callId,
      type: requestType,
      constraints: {
        audio: true,
        video: false
      }
    };

    const messageType = requestType === 'offer' ? 
      SipWorker.MessageType.MEDIA_GET_OFFER : 
      SipWorker.MessageType.MEDIA_GET_ANSWER;

    const request: SipWorker.Message<SipWorker.MediaRequest> = {
      type: messageType,
      id: `media-${requestType}-${Date.now()}`,
      timestamp: Date.now(),
      data: mediaRequest
    };

    try {
      // Increase timeout for answer requests (they might need more time)
      const timeout = requestType === 'answer' ? 15000 : 10000;
      
      this.logger.debug(`Requesting ${requestType} from tab ${selectedTab.id} with ${timeout}ms timeout`);
      
      const response = await this.messageBroker.request(selectedTab.id, request, timeout);
      
      if (response.error) {
        throw new Error(`Failed to get ${requestType}: ${response.error.message}`);
      }

      const sdp = response.data?.sdp;
      if (!sdp) {
        throw new Error(`No SDP received from tab for ${requestType}`);
      }

      this.logger.debug(`Received SDP ${requestType} from tab: ${sdp.substring(0, 100)}...`);

      return {
        body: sdp,
        contentType: 'application/sdp'
      };
    } catch (error) {
      this.logger.error(`Failed to get ${requestType} description: ${error}`);
      
      // Try to select a different tab if current one fails
      if (this.selectedTabId) {
        this.logger.warn(`Tab ${this.selectedTabId} failed, trying to select different tab`);
        this.selectedTabId = undefined; // Reset selected tab
        
        // Try once more with a different tab
        const fallbackTab = await this.tabManager.getSelectedTab();
        if (fallbackTab && fallbackTab.id !== selectedTab.id) {
          this.logger.debug(`Retrying ${requestType} request with fallback tab: ${fallbackTab.id}`);
          this.selectedTabId = fallbackTab.id;
          
          const fallbackRequest = { ...request, id: `fallback-${request.id}` };
          const fallbackResponse = await this.messageBroker.request(fallbackTab.id, fallbackRequest, 10000);
          
          if (fallbackResponse.data?.sdp) {
            this.logger.debug(`Fallback tab succeeded for ${requestType}`);
            return {
              body: fallbackResponse.data.sdp,
              contentType: 'application/sdp'
            };
          }
        }
      }
      
      throw error;
    }
  }

  /**
   * Check if this handler can handle the given content type
   */
  public hasDescription(contentType: string): boolean {
    this.logger.debug('WorkerSessionDescriptionHandler.hasDescription');
    return contentType === 'application/sdp';
  }

  /**
   * Rollback description (optional method)
   */
  public rollbackDescription?(): Promise<void> {
    this.logger.debug('WorkerSessionDescriptionHandler.rollbackDescription');
    return Promise.resolve();
  }

  /**
   * Send DTMF tones
   * Note: DTMF is handled at the SIP protocol level, not at the WebRTC level
   * This is a no-op in WorkerSessionDescriptionHandler since actual DTMF
   * transmission is handled by the SIP stack
   */
  public sendDtmf(tones: string, options?: unknown): boolean {
    this.logger.debug(`WorkerSessionDescriptionHandler.sendDtmf: ${tones} (handled by SIP stack)`);
    
    // DTMF is handled by the SIP protocol layer, not by the SessionDescriptionHandler
    // The SIP stack will use SIP INFO messages or RFC 2833 for DTMF transmission
    // This method just needs to return true to indicate support
    return true;
  }

  /**
   * Set remote description from SIP message
   */
  public async setDescription(
    sdp: string,
    options?: WorkerSessionDescriptionHandlerOptions,
    modifiers?: Array<SessionDescriptionHandlerModifier>
  ): Promise<void> {
    this.logger.debug('WorkerSessionDescriptionHandler.setDescription');
    
    if (this.isClosed) {
      throw new Error('SessionDescriptionHandler is closed');
    }

    // Get the best tab to handle media (use cached tab for consistency)
    let selectedTab;
    if (this.selectedTabId) {
      selectedTab = this.tabManager.getTab(this.selectedTabId);
    }
    
    if (!selectedTab) {
      selectedTab = await this.tabManager.getSelectedTab();
      if (!selectedTab) {
        throw new Error('No tab available for media handling');
      }
      this.selectedTabId = selectedTab.id;
      
      // Update handlingTabId in WorkerState if available
      if (this.workerState) {
        const existingCallInfo = this.workerState.getActiveCall(this.callId);
        if (existingCallInfo) {
          console.log(`WorkerSDH.setDescription: Setting handlingTabId ${selectedTab.id} for callId ${this.callId}`);
          this.workerState.setActiveCall(this.callId, {
            ...existingCallInfo,
            handlingTabId: selectedTab.id
          });
        } else {
          console.warn(`WorkerSDH.setDescription: No existing call info found for callId ${this.callId} when trying to set handlingTabId`);
        }
      }
    }

    this.logger.debug(`Setting remote SDP for tab: ${selectedTab.id} (early media: ${this.isEarlyMedia}, callId: ${this.callId})`);

    // Send remote SDP to tab
    const mediaRequest: SipWorker.MediaRequest = {
      callId: this.callId,
      type: 'set-remote-sdp',
      sdp: sdp
    };

    const request: SipWorker.Message<SipWorker.MediaRequest> = {
      type: SipWorker.MessageType.MEDIA_SET_REMOTE_SDP,
      id: `media-remote-sdp-${Date.now()}`,
      timestamp: Date.now(),
      data: mediaRequest
    };

    try {
      const response = await this.messageBroker.request(selectedTab.id, request, 10000);
      
      if (response.error) {
        throw new Error(`Failed to set remote SDP: ${response.error.message}`);
      }

      this.logger.debug(`Remote SDP set successfully on tab: ${selectedTab.id}`);
    } catch (error) {
      this.logger.error(`Failed to set remote description: ${error}`);
      throw error;
    }
  }
}

/**
 * Factory function for WorkerSessionDescriptionHandler
 */
export function createWorkerSessionDescriptionHandlerFactory(
  messageBroker: MessageBroker,
  tabManager: TabManager,
  workerState?: WorkerState,
): (session: any, options?: any) => WorkerSessionDescriptionHandler {
  return (session: any, options?: any): WorkerSessionDescriptionHandler => {
    // Try to get logger from session's userAgent, fallback to console logger
    let logger: Logger;
    try {
      logger = session.userAgent.getLogger('sip.WorkerSessionDescriptionHandler');
    } catch (error) {
      // Fallback logger if userAgent is not available
      logger = {
        debug: (message: string) => console.debug(`[WorkerSDH] ${message}`),
        log: (message: string) => console.log(`[WorkerSDH] ${message}`),
        warn: (message: string) => console.warn(`[WorkerSDH] ${message}`),
        error: (message: string) => console.error(`[WorkerSDH] ${message}`)
      } as Logger;
    }
    
    // Require callId from sessionDescriptionHandlerOptions - throw error if not provided
    const callId = (session.sessionDescriptionHandlerOptions as any)?.callId;
    if (!callId) {
      throw new Error('WorkerSessionDescriptionHandlerOptions.callId is required in sessionDescriptionHandlerOptions');
    }
    
    console.log('WorkerSDH: callId from options:', callId);
    console.log('WorkerSDH: session.id:', session.id);
    
    // Check if this is for early media (based on session type or options)
    const isEarlyMedia = options?.isEarlyMedia || false;
    
    return new WorkerSessionDescriptionHandler(
      logger,
      messageBroker,
      tabManager,
      callId, // Use callId directly
      isEarlyMedia,
      session, // Pass session để detect context
      workerState // Pass workerState để update handlingTabId
    );
  };
} 