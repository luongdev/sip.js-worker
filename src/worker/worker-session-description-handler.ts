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

    // For now, return a placeholder SDP
    // In real implementation, this would delegate to the selected tab
    return {
      body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n',
      contentType: 'application/sdp'
    };
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

    // For now, just log the SDP
    // In real implementation, this would delegate to the selected tab
    this.logger.debug(`Received SDP: ${sdp}`);
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