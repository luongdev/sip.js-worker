import { SessionDescriptionHandler as SDHInterface, SessionDescriptionHandlerOptions, SessionDescriptionHandlerModifier, BodyAndContentType } from 'sip.js/lib/api';
import { Logger } from 'sip.js/lib/core';
import { MessageBroker } from './message-broker';
import { TabManager } from './tab-manager';
import { SipWorker } from '../common/types';

/**
 * Custom SessionDescriptionHandler for Worker mode
 * Redirects all media operations to the appropriate tab instead of handling them in worker
 */
export class WorkerSessionDescriptionHandler implements SDHInterface {
  private logger: Logger;
  private messageBroker: MessageBroker;
  private tabManager: TabManager;
  private sessionId: string;
  private isClosed: boolean = false;

  constructor(
    logger: Logger,
    messageBroker: MessageBroker,
    tabManager: TabManager,
    sessionId: string
  ) {
    this.logger = logger;
    this.messageBroker = messageBroker;
    this.tabManager = tabManager;
    this.sessionId = sessionId;
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
    options?: SessionDescriptionHandlerOptions,
    modifiers?: Array<SessionDescriptionHandlerModifier>
  ): Promise<BodyAndContentType> {
    this.logger.debug('WorkerSessionDescriptionHandler.getDescription');
    
    if (this.isClosed) {
      throw new Error('SessionDescriptionHandler is closed');
    }

    // Get the best tab to handle media
    const selectedTab = await this.tabManager.getSelectedTab();
    if (!selectedTab) {
      throw new Error('No tab available for media handling');
    }

    this.logger.debug(`Requesting SDP offer from tab: ${selectedTab.id}`);

    // Send media request to tab
    const mediaRequest: SipWorker.MediaRequest = {
      sessionId: this.sessionId,
      type: 'offer',
      constraints: {
        audio: true,
        video: false
      }
    };

    const request: SipWorker.Message<SipWorker.MediaRequest> = {
      type: SipWorker.MessageType.MEDIA_GET_OFFER,
      id: `media-offer-${Date.now()}`,
      timestamp: Date.now(),
      data: mediaRequest
    };

    try {
      const response = await this.messageBroker.request(selectedTab.id, request, 10000);
      
      if (response.error) {
        throw new Error(`Failed to get offer: ${response.error.message}`);
      }

      const sdp = response.data?.sdp;
      if (!sdp) {
        throw new Error('No SDP received from tab');
      }

      this.logger.debug(`Received SDP offer from tab: ${sdp.substring(0, 100)}...`);

      return {
        body: sdp,
        contentType: 'application/sdp'
      };
    } catch (error) {
      this.logger.error(`Failed to get description: ${error}`);
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
   */
  public sendDtmf(tones: string, options?: unknown): boolean {
    this.logger.debug('WorkerSessionDescriptionHandler.sendDtmf');
    // Delegate DTMF to the tab
    // For now, return false to indicate not supported
    return false;
  }

  /**
   * Set remote description from SIP message
   */
  public async setDescription(
    sdp: string,
    options?: SessionDescriptionHandlerOptions,
    modifiers?: Array<SessionDescriptionHandlerModifier>
  ): Promise<void> {
    this.logger.debug('WorkerSessionDescriptionHandler.setDescription');
    
    if (this.isClosed) {
      throw new Error('SessionDescriptionHandler is closed');
    }

    // Get the best tab to handle media
    const selectedTab = await this.tabManager.getSelectedTab();
    if (!selectedTab) {
      throw new Error('No tab available for media handling');
    }

    this.logger.debug(`Setting remote SDP for tab: ${selectedTab.id}`);

    // Send remote SDP to tab
    const mediaRequest: SipWorker.MediaRequest = {
      sessionId: this.sessionId,
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
  tabManager: TabManager
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
    
    const sessionId = session.id || `session-${Date.now()}`;
    
    return new WorkerSessionDescriptionHandler(
      logger,
      messageBroker,
      tabManager,
      sessionId
    );
  };
} 