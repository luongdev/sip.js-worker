import { SipWorker } from '../common/types';

/**
 * Callback interface để gửi tin nhắn về worker
 */
export interface MediaHandlerCallbacks {
  sendIceCandidate: (callId: string, candidate: RTCIceCandidate) => void;
  sendSessionReady: (callId: string) => void;
  sendSessionFailed: (callId: string, error: string) => void;
  handleRemoteStream: (callId: string, stream: MediaStream) => void;
  sendSdpCache: (callId: string, localSdp: string, remoteSdp: string) => void;
}

/**
 * Configuration cho MediaHandler, inspired by SIP.js SessionDescriptionHandlerConfiguration
 */
export interface MediaHandlerConfiguration {
  /**
   * ICE gathering timeout (ms)
   */
  iceGatheringTimeout?: number;
  
  /**
   * RTCPeerConnection configuration
   */
  peerConnectionConfiguration?: RTCConfiguration;
  
  /**
   * Default media constraints
   */
  defaultConstraints?: MediaStreamConstraints;
}

/**
 * Session state để track trạng thái của mỗi session
 */
interface SessionState {
  peerConnection: RTCPeerConnection;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  iceCandidatesQueue: RTCIceCandidateInit[];
  iceGatheringComplete: boolean;
  iceGatheringPromise?: Promise<void>;
  iceGatheringResolve?: () => void;
  iceGatheringReject?: (error: Error) => void;
  iceGatheringTimeoutId?: number;
}

/**
 * MediaHandler class inspired by SIP.js SessionDescriptionHandler
 * Handles media negotiation between tab and worker with proper WebRTC workflow
 */
export class MediaHandler {
  private sessions: Map<string, SessionState> = new Map();
  private callbacks: MediaHandlerCallbacks | null = null;
  private configuration: MediaHandlerConfiguration;

  /**
   * Default configuration inspired by SIP.js defaults
   */
  private static readonly DEFAULT_CONFIG: MediaHandlerConfiguration = {
    iceGatheringTimeout: 10000, // Increased from 5000 to 10000ms
    peerConnectionConfiguration: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      bundlePolicy: 'balanced',
      rtcpMuxPolicy: 'require'
    },
    defaultConstraints: {
      audio: true,
      video: false
    }
  };

  /**
   * Constructor
   */
  constructor(callbacks?: MediaHandlerCallbacks, configuration?: MediaHandlerConfiguration) {
    this.callbacks = callbacks || null;
    this.configuration = { ...MediaHandler.DEFAULT_CONFIG, ...configuration };
    console.log('MediaHandler initialized with SIP.js-inspired workflow');
  }

  /**
   * Set callbacks for MediaHandler
   */
  public setCallbacks(callbacks: MediaHandlerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Handle media request from worker - main entry point like SIP.js getDescription/setDescription
   */
  public async handleMediaRequest(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    console.log('Handling media request:', request.type, 'for call:', request.callId);

    try {
      switch (request.type) {
        case 'offer':
          return await this.createOfferDescription(request);
        case 'answer':
          return await this.createAnswerDescription(request);
        case 'set-remote-sdp':
          return await this.setRemoteDescription(request);
        case 'ice-candidate':
          return await this.addIceCandidate(request);
        default:
          throw new Error(`Unsupported media request type: ${request.type}`);
      }
    } catch (error: any) {
      console.error('Media request failed:', error);
      this.sendSessionFailedToWorker(request.callId, error.message);
      return {
        callId: request.callId,
        success: false,
        error: error.message || 'Unknown media error'
      };
    }
  }

  /**
   * Handle DTMF request from worker
   */
  public async handleDtmfRequest(request: SipWorker.DtmfRequest): Promise<SipWorker.DtmfResponse> {
    console.log('Handling WebRTC DTMF request - tones:', request?.tones, 'callId:', request?.callId);

    try {
      // Validate request
      if (!request || typeof request !== 'object' || !request.callId || !request.tones) {
        console.error('Invalid DTMF request:', request);
        throw new Error('Invalid DTMF request: missing callId or tones');
      }
      if (!request.tones) {
        throw new Error('No tones provided in DTMF request');
      }

      const sessionState = this.sessions.get(request.callId);
      if (!sessionState) {
        console.log('Available sessions:', Array.from(this.sessions.keys()));
        throw new Error(`Session not found for callId: ${request.callId}`);
      }

      console.log('Session found, peerConnection state:', sessionState.peerConnection.connectionState);
      console.log('Session signaling state:', sessionState.peerConnection.signalingState);

      // Get DTMF sender from the first audio track
      const senders = sessionState.peerConnection.getSenders();
      console.log('Available senders:', senders.length);
      
      const sender = senders.find(s => {
        console.log('Sender track:', s.track?.kind, s.track?.id);
        return s.track && s.track.kind === 'audio';
      });

      if (!sender) {
        throw new Error('No audio sender found for DTMF');
      }

      console.log('Audio sender found:', sender);
      console.log('DTMF capabilities:', sender.dtmf ? 'supported' : 'not supported');

      if (!sender.dtmf) {
        throw new Error('DTMF not supported by this sender');
      }

      // Send DTMF tones
      const duration = request.duration || 100;
      const interToneGap = request.interToneGap || 100;
      
      console.log(`Sending DTMF: "${request.tones}" with duration: ${duration}ms, gap: ${interToneGap}ms`);
      sender.dtmf.insertDTMF(request.tones, duration, interToneGap);

      console.log('DTMF sent successfully:', request.tones);

      return {
        callId: request.callId,
        success: true,
        tones: request.tones
      };
    } catch (error: any) {
      console.error('DTMF request failed:', error);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      
      return {
        callId: request.callId,
        success: false,
        tones: request.tones,
        error: error.message || 'Unknown DTMF error'
      };
    }
  }

  /**
   * Mute audio tracks for a call
   */
  public async muteAudio(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Muting audio for call/session:', callId);

    try {
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Disable all audio tracks
      sessionState.localStream.getAudioTracks().forEach(track => {
        track.enabled = false;
        console.log('Audio track muted:', track.id);
      });

      console.log('Audio muted successfully for call/session:', callId);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to mute audio:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unmute audio tracks for a call
   */
  public async unmuteAudio(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Unmuting audio for call/session:', callId);

    try {
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Enable all audio tracks
      sessionState.localStream.getAudioTracks().forEach(track => {
        track.enabled = true;
        console.log('Audio track unmuted:', track.id);
      });

      console.log('Audio unmuted successfully for call/session:', callId);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to unmute audio:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Mute video tracks for a call
   */
  public async muteVideo(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Muting video for call:', callId);

    try {
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Disable all video tracks
      sessionState.localStream.getVideoTracks().forEach(track => {
        track.enabled = false;
        console.log('Video track muted:', track.id);
      });

      console.log('Video muted successfully for call:', callId);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to mute video:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unmute video tracks for a call
   */
  public async unmuteVideo(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Unmuting video for call:', callId);

    try {
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Enable all video tracks
      sessionState.localStream.getVideoTracks().forEach(track => {
        track.enabled = true;
        console.log('Video track unmuted:', track.id);
      });

      console.log('Video unmuted successfully for call:', callId);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to unmute video:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create offer description - inspired by SIP.js getDescription() for offers
   */
  private async createOfferDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { callId, constraints } = request;

    // Create or get session state
    let sessionState = this.sessions.get(callId);
    if (!sessionState) {
      sessionState = await this.createSession(callId);
    }

    // Get local media stream (similar to SIP.js getLocalMediaStream)
    await this.getLocalMediaStream(sessionState, constraints);

    // Create local offer (similar to SIP.js createLocalOfferOrAnswer)
    const offer = await this.createLocalOffer(sessionState);
    
    // Set local description
    await this.setLocalDescription(sessionState, offer);
    
    // Wait for ICE gathering to complete (like SIP.js waitForIceGatheringComplete)
    await this.waitForIceGatheringComplete(sessionState);
    
    // Get final local description with ICE candidates
    const finalDescription = sessionState.peerConnection.localDescription;
    if (!finalDescription?.sdp) {
      throw new Error('Failed to get local description');
    }

    sessionState.localDescription = finalDescription;

    console.log('Created offer description for call:', callId);

    // Cache SDP for hold/unhold if both local and remote are available
    this.tryCacheSdp(callId, sessionState);

    return {
      callId,
      success: true,
      sdp: finalDescription.sdp
    };
  }

  /**
   * Create answer description - inspired by SIP.js getDescription() for answers
   */
  private async createAnswerDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { callId, constraints } = request;

    let sessionState = this.sessions.get(callId);
    if (!sessionState) {
      // For incoming calls, session might not exist yet - create it
      console.log('Creating new call session for answer request:', callId);
      sessionState = await this.createSession(callId);
    }

    // Check if we have remote description, if not wait a bit
    if (!sessionState.remoteDescription) {
      console.log('No remote description yet, waiting for setRemoteDescription...');
      
      // Wait up to 5 seconds for remote description to be set
      let retries = 10;
      while (retries > 0 && !sessionState.remoteDescription) {
        await new Promise(resolve => setTimeout(resolve, 500));
        retries--;
      }
      
      if (!sessionState.remoteDescription) {
        throw new Error('Cannot create answer without remote description - timeout waiting for remote SDP');
      }
    }

    console.log('Creating answer for call:', callId, 'signaling state:', sessionState.peerConnection.signalingState);

    // Get local media stream
    await this.getLocalMediaStream(sessionState, constraints);

    // Create local answer
    const answer = await this.createLocalAnswer(sessionState);
    
    // Set local description
    await this.setLocalDescription(sessionState, answer);
    
    // Wait for ICE gathering
    await this.waitForIceGatheringComplete(sessionState);
    
    // Get final description
    const finalDescription = sessionState.peerConnection.localDescription;
    if (!finalDescription?.sdp) {
      throw new Error('Failed to get local answer description');
    }

    sessionState.localDescription = finalDescription;

    console.log('Created answer description for call:', callId);

    // Cache SDP for hold/unhold if both local and remote are available
    this.tryCacheSdp(callId, sessionState);

    return {
      callId,
      success: true,
      sdp: finalDescription.sdp
    };
  }

  /**
   * Set remote description - inspired by SIP.js setDescription()
   */
  private async setRemoteDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { callId, sdp } = request;

    if (!sdp) {
      throw new Error('SDP is required for set-remote-sdp request');
    }

    let sessionState = this.sessions.get(callId);
    if (!sessionState) {
      // Create session for incoming call
      sessionState = await this.createSession(callId);
    }

    const pc = sessionState.peerConnection;
    console.log('MediaHandler.setRemoteDescription - current signaling state:', pc.signalingState);
    
    // Parse SDP to determine type (more reliable than signaling state)
    let type: RTCSdpType;
    const isOffer = sdp.includes('a=setup:actpass') || sdp.includes('a=setup:active') || !sdp.includes('a=setup:passive');
    
    // Primary logic: Use signaling state when reliable
    switch (pc.signalingState) {
      case 'stable':
        // In stable state, incoming SDP should be an offer
        type = 'offer';
        break;
      case 'have-local-offer':
        // We made an offer, incoming should be answer
        type = 'answer';
        break;
      case 'have-remote-offer':
        // We already have remote offer - this might be early media update
        console.warn('Already have remote offer, this might be early media or retransmission');
        type = 'offer'; // Treat as updated offer
        break;
      case 'have-local-pranswer':
      case 'have-remote-pranswer':
        // Handle provisional answers
        type = pc.signalingState === 'have-local-pranswer' ? 'answer' : 'offer';
        break;
      default:
        // Fallback: Determine from SDP content
        type = isOffer ? 'offer' : 'answer';
        console.warn(`Unusual signaling state (${pc.signalingState}), determined type from SDP content: ${type}`);
    }

    const remoteDescription: RTCSessionDescriptionInit = { type, sdp };
    
    try {
      console.log(`Setting remote description: type=${type}, signalingState=${pc.signalingState}`);
      
      // For 'have-remote-offer' state, we might need to rollback first
      if (pc.signalingState === 'have-remote-offer' && type === 'offer') {
        console.log('Rolling back previous remote offer before setting new one');
        await pc.setRemoteDescription({ type: 'rollback' });
      }
      
      await pc.setRemoteDescription(remoteDescription);
      sessionState.remoteDescription = remoteDescription;

      // Process queued ICE candidates
      await this.processQueuedIceCandidates(sessionState);

      console.log('Set remote description for call:', callId, 'type:', type);

      return {
        callId,
        success: true
      };
    } catch (error: any) {
      console.error('Failed to set remote description:', error);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        signalingState: pc.signalingState,
        sdpType: type,
        sdpLength: sdp.length
      });
      
      // Try alternative approach for some common errors
      if (error.name === 'InvalidStateError' && type === 'offer') {
        try {
          console.log('Retrying with rollback approach...');
          await pc.setRemoteDescription({ type: 'rollback' });
          await pc.setRemoteDescription(remoteDescription);
          sessionState.remoteDescription = remoteDescription;
          await this.processQueuedIceCandidates(sessionState);
          console.log('Retry successful after rollback');
          return { callId, success: true };
        } catch (retryError) {
          console.error('Retry also failed:', retryError);
        }
      }
      
      throw error;
    }
  }

  /**
   * Add ICE candidate - inspired by SIP.js ice candidate handling
   */
  private async addIceCandidate(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { callId, candidate } = request;

    if (!candidate) {
      throw new Error('ICE candidate is required');
    }

    const sessionState = this.sessions.get(callId);
    if (!sessionState) {
      throw new Error(`No session found for callId: ${callId}`);
    }

    const pc = sessionState.peerConnection;
    
    // Check if we can add the candidate immediately
    if (sessionState.remoteDescription) {
      try {
        await pc.addIceCandidate(candidate);
        console.log('Added ICE candidate for call:', callId);
      } catch (error) {
        console.warn('Failed to add ICE candidate:', error);
        throw error;
      }
    } else {
      // Queue candidate for later processing
      sessionState.iceCandidatesQueue.push(candidate);
      console.log('Queued ICE candidate for call:', callId);
    }

    return {
      callId,
      success: true
    };
  }

  /**
   * Create a new session state - like SIP.js constructor
   */
  private async createSession(callId: string): Promise<SessionState> {
    console.log('Creating new call session:', callId);

    const peerConnection = new RTCPeerConnection(this.configuration.peerConnectionConfiguration);
    
    const sessionState: SessionState = {
      peerConnection,
      iceCandidatesQueue: [],
      iceGatheringComplete: false
    };

    // Set up event handlers (inspired by SIP.js initPeerConnectionEventHandlers)
    this.initPeerConnectionEventHandlers(sessionState, callId);

    this.sessions.set(callId, sessionState);
    return sessionState;
  }

  /**
   * Initialize PeerConnection event handlers - inspired by SIP.js
   */
  private initPeerConnectionEventHandlers(sessionState: SessionState, callId: string): void {
    const pc = sessionState.peerConnection;

    // ICE candidate handler
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        console.log('ICE candidate generated:', event.candidate.candidate);
        this.sendIceCandidateToWorker(callId, event.candidate);
      } else {
        // ICE gathering complete
        console.log('ICE gathering complete for call:', callId);
        sessionState.iceGatheringComplete = true;
        
        // Clear timeout
        if (sessionState.iceGatheringTimeoutId) {
          clearTimeout(sessionState.iceGatheringTimeoutId);
          sessionState.iceGatheringTimeoutId = undefined;
        }
        
        if (sessionState.iceGatheringResolve) {
          sessionState.iceGatheringResolve();
        }
      }
    });

    // ICE gathering state change
    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`ICE gathering state changed to: ${pc.iceGatheringState} for call: ${callId}`);
    });

    // ICE connection state change
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log('ICE connection state:', pc.iceConnectionState, 'for call:', callId);
      
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.sendSessionReadyToWorker(callId);
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this.sendSessionFailedToWorker(callId, `ICE connection failed: ${pc.iceConnectionState}`);
      }
    });

    // Remote stream handler
    pc.addEventListener('track', (event) => {
      console.log('Received remote track for call:', callId);
      const [remoteStream] = event.streams;
      if (remoteStream) {
        sessionState.remoteStream = remoteStream;
        this.handleRemoteStream(callId, remoteStream);
      }
    });

    // Connection state change
    pc.addEventListener('connectionstatechange', () => {
      console.log('Connection state:', pc.connectionState, 'for call:', callId);
    });
  }

  /**
   * Get local media stream - inspired by SIP.js getLocalMediaStream
   */
  private async getLocalMediaStream(sessionState: SessionState, constraints?: SipWorker.MediaConstraints): Promise<void> {
    // Use provided constraints or defaults
    const mediaConstraints: MediaStreamConstraints = {
      ...this.configuration.defaultConstraints,
      ...constraints
    };

    // Skip if we already have a compatible stream
    if (sessionState.localStream) {
      // TODO: Check if current stream matches constraints
      return;
    }

    console.log('Getting user media with constraints:', mediaConstraints);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      sessionState.localStream = stream;

      // Add tracks to peer connection (like SIP.js setLocalMediaStream)
      stream.getTracks().forEach(track => {
        console.log('Adding track to PeerConnection:', track.kind, track.label);
        sessionState.peerConnection.addTrack(track, stream);
      });

    } catch (error: any) {
      console.error('Failed to get user media:', error);
      throw new Error(`Media access denied: ${error.message}`);
    }
  }

  /**
   * Create local offer - inspired by SIP.js createLocalOfferOrAnswer
   */
  private async createLocalOffer(sessionState: SessionState): Promise<RTCSessionDescriptionInit> {
    const pc = sessionState.peerConnection;
    
    if (pc.signalingState !== 'stable') {
      throw new Error(`Cannot create offer in signaling state: ${pc.signalingState}`);
    }

    console.log('Creating local offer');
    return await pc.createOffer();
  }

  /**
   * Create local answer - inspired by SIP.js createLocalOfferOrAnswer
   */
  private async createLocalAnswer(sessionState: SessionState): Promise<RTCSessionDescriptionInit> {
    const pc = sessionState.peerConnection;
    
    if (pc.signalingState !== 'have-remote-offer') {
      throw new Error(`Cannot create answer in signaling state: ${pc.signalingState}`);
    }

    console.log('Creating local answer');
    return await pc.createAnswer();
  }

  /**
   * Set local description
   */
  private async setLocalDescription(sessionState: SessionState, description: RTCSessionDescriptionInit): Promise<void> {
    console.log('Setting local description:', description.type);
    await sessionState.peerConnection.setLocalDescription(description);
    
    // Reset ICE gathering state
    sessionState.iceGatheringComplete = false;
    sessionState.iceGatheringPromise = undefined;
  }

  /**
   * Wait for ICE gathering to complete - inspired by SIP.js waitForIceGatheringComplete
   */
  private async waitForIceGatheringComplete(sessionState: SessionState): Promise<void> {
    if (sessionState.iceGatheringComplete) {
      console.log('ICE gathering already complete');
      return Promise.resolve();
    }

    if (sessionState.iceGatheringPromise) {
      console.log('ICE gathering already in progress, waiting...');
      return sessionState.iceGatheringPromise;
    }

    console.log(`Starting ICE gathering with timeout: ${this.configuration.iceGatheringTimeout}ms`);
    const startTime = Date.now();

    sessionState.iceGatheringPromise = new Promise<void>((resolve, reject) => {
      sessionState.iceGatheringResolve = resolve;
      sessionState.iceGatheringReject = reject;

      // Set timeout
      if (this.configuration.iceGatheringTimeout! > 0) {
        sessionState.iceGatheringTimeoutId = setTimeout(() => {
          const duration = Date.now() - startTime;
          console.warn(`ICE gathering timeout after ${duration}ms, proceeding anyway`);
          sessionState.iceGatheringComplete = true;
          resolve();
        }, this.configuration.iceGatheringTimeout) as any;
      }
    });

    return sessionState.iceGatheringPromise;
  }

  /**
   * Process queued ICE candidates
   */
  private async processQueuedIceCandidates(sessionState: SessionState): Promise<void> {
    const candidates = sessionState.iceCandidatesQueue.splice(0);
    console.log('Processing', candidates.length, 'queued ICE candidates');

    for (const candidate of candidates) {
      try {
        await sessionState.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Failed to add queued ICE candidate:', error);
      }
    }
  }

  /**
   * Send ICE candidate to worker
   */
  private sendIceCandidateToWorker(callId: string, candidate: RTCIceCandidate): void {
    if (this.callbacks?.sendIceCandidate) {
      this.callbacks.sendIceCandidate(callId, candidate);
    }
  }

  /**
   * Send session ready to worker
   */
  private sendSessionReadyToWorker(callId: string): void {
    if (this.callbacks?.sendSessionReady) {
      this.callbacks.sendSessionReady(callId);
    }
  }

  /**
   * Send session failed to worker
   */
  private sendSessionFailedToWorker(callId: string, error: string): void {
    if (this.callbacks?.sendSessionFailed) {
      this.callbacks.sendSessionFailed(callId, error);
    }
  }

  /**
   * Handle remote stream
   */
  private handleRemoteStream(callId: string, stream: MediaStream): void {
    if (this.callbacks?.handleRemoteStream) {
      this.callbacks.handleRemoteStream(callId, stream);
    }
  }

  /**
   * Cleanup session
   */
  public cleanupSession(callId: string): void {
    const sessionState = this.sessions.get(callId);
    if (!sessionState) {
      return;
    }

    console.log('Cleaning up call session:', callId);

    // Clear ICE gathering timeout
    if (sessionState.iceGatheringTimeoutId) {
      clearTimeout(sessionState.iceGatheringTimeoutId);
    }

    // Stop local stream tracks
    if (sessionState.localStream) {
      sessionState.localStream.getTracks().forEach(track => track.stop());
    }

    // Close peer connection
    if (sessionState.peerConnection.connectionState !== 'closed') {
      sessionState.peerConnection.close();
    }

    this.sessions.delete(callId);
  }

  /**
   * Cleanup all sessions
   */
  public cleanup(): void {
    console.log('Cleaning up MediaHandler');
    
    for (const callId of this.sessions.keys()) {
      this.cleanupSession(callId);
    }
    
    this.sessions.clear();
  }

  /**
   * Get session info for debugging
   */
  public getSessionInfo(callId: string): any {
    const sessionState = this.sessions.get(callId);
    if (!sessionState) {
      return null;
    }

    return {
      callId,
      signalingState: sessionState.peerConnection.signalingState,
      iceConnectionState: sessionState.peerConnection.iceConnectionState,
      connectionState: sessionState.peerConnection.connectionState,
      iceGatheringComplete: sessionState.iceGatheringComplete,
      hasLocalStream: !!sessionState.localStream,
      hasRemoteStream: !!sessionState.remoteStream,
      queuedCandidates: sessionState.iceCandidatesQueue.length
    };
  }

  /**
   * Try to cache SDP for hold/unhold functionality
   */
  private tryCacheSdp(callId: string, sessionState: SessionState): void {
    // Only cache when we have both local and remote descriptions
    if ((sessionState.localDescription?.sdp || sessionState.remoteDescription?.sdp) && this.callbacks?.sendSdpCache) {
      console.log('Caching SDP for hold/unhold functionality:', callId);
      this.callbacks.sendSdpCache(
        callId,
        sessionState?.localDescription?.sdp || '',
        sessionState?.remoteDescription?.sdp || ''
      );
    }
  }
} 