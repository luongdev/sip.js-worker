import { SipWorker } from '../common/types';

/**
 * Callback interface để gửi tin nhắn về worker
 */
export interface MediaHandlerCallbacks {
  sendIceCandidate: (sessionId: string, candidate: RTCIceCandidate) => void;
  sendSessionReady: (sessionId: string) => void;
  sendSessionFailed: (sessionId: string, error: string) => void;
  handleRemoteStream: (sessionId: string, stream: MediaStream) => void;
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
    console.log('Handling media request:', request.type, 'for session:', request.sessionId);

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
      this.sendSessionFailedToWorker(request.sessionId, error.message);
      return {
        sessionId: request.sessionId,
        success: false,
        error: error.message || 'Unknown media error'
      };
    }
  }

  /**
   * Handle DTMF request from worker
   */
  public async handleDtmfRequest(request: SipWorker.DtmfRequest): Promise<SipWorker.DtmfResponse> {
    console.log('Handling DTMF request:', request.tones, 'for call:', request.callId);

    try {
      const sessionState = this.sessions.get(request.callId);
      if (!sessionState) {
        throw new Error('Session not found');
      }

      // Get DTMF sender from the first audio track
      const sender = sessionState.peerConnection.getSenders().find(s => 
        s.track && s.track.kind === 'audio'
      );

      if (!sender) {
        throw new Error('No audio sender found for DTMF');
      }

      if (!sender.dtmf) {
        throw new Error('DTMF not supported');
      }

      // Send DTMF tones
      const duration = request.duration || 100;
      const interToneGap = request.interToneGap || 100;
      
      sender.dtmf.insertDTMF(request.tones, duration, interToneGap);

      console.log('DTMF sent successfully:', request.tones);

      return {
        callId: request.callId,
        success: true,
        tones: request.tones
      };
    } catch (error: any) {
      console.error('DTMF request failed:', error);
      return {
        callId: request.callId,
        success: false,
        tones: request.tones,
        error: error.message || 'Unknown DTMF error'
      };
    }
  }

  /**
   * Mute audio tracks for a session (now callId = sessionId thanks to our hack)
   */
  public async muteAudio(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Muting audio for call/session:', callId);
    console.log('Available sessions:', Array.from(this.sessions.keys()));

    try {
      // Now callId should be the same as sessionId thanks to our hack
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        // This tab doesn't have this session - this is normal when forwarding to specific tab
        console.log('Session not found for callId:', callId, '- this tab does not own this session');
        console.log('Available sessions:', Array.from(this.sessions.keys()));
        return { success: false, error: 'Session not found in this tab' };
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
   * Unmute audio tracks for a session (now callId = sessionId thanks to our hack)
   */
  public async unmuteAudio(callId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Unmuting audio for call/session:', callId);

    try {
      // Now callId should be the same as sessionId thanks to our hack
      const sessionState = this.sessions.get(callId);
      if (!sessionState || !sessionState.localStream) {
        // This tab doesn't have this session - this is normal when forwarding to specific tab
        console.log('Session not found for callId:', callId, '- this tab does not own this session');
        console.log('Available sessions:', Array.from(this.sessions.keys()));
        return { success: false, error: 'Session not found in this tab' };
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
   * Mute video tracks for a session
   */
  public async muteVideo(sessionId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Muting video for session:', sessionId);

    try {
      const sessionState = this.sessions.get(sessionId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Disable all video tracks
      sessionState.localStream.getVideoTracks().forEach(track => {
        track.enabled = false;
        console.log('Video track muted:', track.id);
      });

      console.log('Video muted successfully for session:', sessionId);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to mute video:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unmute video tracks for a session
   */
  public async unmuteVideo(sessionId: string): Promise<{ success: boolean; error?: string }> {
    console.log('Unmuting video for session:', sessionId);

    try {
      const sessionState = this.sessions.get(sessionId);
      if (!sessionState || !sessionState.localStream) {
        throw new Error('Session or local stream not found');
      }

      // Enable all video tracks
      sessionState.localStream.getVideoTracks().forEach(track => {
        track.enabled = true;
        console.log('Video track unmuted:', track.id);
      });

      console.log('Video unmuted successfully for session:', sessionId);
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
    const { sessionId, constraints } = request;

    // Create or get session state
    let sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      sessionState = await this.createSession(sessionId);
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

    console.log('Created offer description for session:', sessionId);

    return {
      sessionId,
      success: true,
      sdp: finalDescription.sdp
    };
  }

  /**
   * Create answer description - inspired by SIP.js getDescription() for answers
   */
  private async createAnswerDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, constraints } = request;

    let sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      // For incoming calls, session might not exist yet - create it
      console.log('Creating new session for answer request:', sessionId);
      sessionState = await this.createSession(sessionId);
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

    console.log('Creating answer for session:', sessionId, 'signaling state:', sessionState.peerConnection.signalingState);

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

    console.log('Created answer description for session:', sessionId);

    return {
      sessionId,
      success: true,
      sdp: finalDescription.sdp
    };
  }

  /**
   * Set remote description - inspired by SIP.js setDescription()
   */
  private async setRemoteDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, sdp } = request;

    if (!sdp) {
      throw new Error('SDP is required for set-remote-sdp request');
    }

    let sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      // Create session for incoming call
      sessionState = await this.createSession(sessionId);
    }

    // Determine SDP type based on current signaling state (like SIP.js)
    const pc = sessionState.peerConnection;
    let type: RTCSdpType;
    
    switch (pc.signalingState) {
      case 'stable':
        // If we are stable, this should be a remote offer
        type = 'offer';
        break;
      case 'have-local-offer':
        // If we made an offer, this should be a remote answer
        type = 'answer';
        break;
      default:
        throw new Error(`Invalid signaling state for setRemoteDescription: ${pc.signalingState}`);
    }

    const remoteDescription: RTCSessionDescriptionInit = { type, sdp };
    
    // Set remote description
    await pc.setRemoteDescription(remoteDescription);
    sessionState.remoteDescription = remoteDescription;

    // Process queued ICE candidates
    await this.processQueuedIceCandidates(sessionState);

    console.log('Set remote description for session:', sessionId, 'type:', type);

    return {
      sessionId,
      success: true
    };
  }

  /**
   * Add ICE candidate
   */
  private async addIceCandidate(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, candidate } = request;

    if (!candidate) {
      throw new Error('ICE candidate is required');
    }

    const sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      throw new Error(`No session found for sessionId: ${sessionId}`);
    }

    const pc = sessionState.peerConnection;
    
    // Check if we can add the candidate now or need to queue it
    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(candidate);
        console.log('Added ICE candidate for session:', sessionId);
      } catch (error) {
        console.warn('Failed to add ICE candidate:', error);
        // Non-fatal error, continue
      }
    } else {
      // Queue candidate for later processing
      sessionState.iceCandidatesQueue.push(candidate);
      console.log('Queued ICE candidate for session:', sessionId);
    }

    return {
      sessionId,
      success: true
    };
  }

  /**
   * Create a new session state - like SIP.js constructor
   */
  private async createSession(sessionId: string): Promise<SessionState> {
    console.log('Creating new session:', sessionId);

    const peerConnection = new RTCPeerConnection(this.configuration.peerConnectionConfiguration);
    
    const sessionState: SessionState = {
      peerConnection,
      iceCandidatesQueue: [],
      iceGatheringComplete: false
    };

    // Set up event handlers (inspired by SIP.js initPeerConnectionEventHandlers)
    this.initPeerConnectionEventHandlers(sessionState, sessionId);

    this.sessions.set(sessionId, sessionState);
    return sessionState;
  }

  /**
   * Initialize PeerConnection event handlers - inspired by SIP.js
   */
  private initPeerConnectionEventHandlers(sessionState: SessionState, sessionId: string): void {
    const pc = sessionState.peerConnection;

    // ICE candidate handler
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        console.log('ICE candidate generated:', event.candidate.candidate);
        this.sendIceCandidateToWorker(sessionId, event.candidate);
      } else {
        // ICE gathering complete
        console.log('ICE gathering complete for session:', sessionId);
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
      console.log(`ICE gathering state changed to: ${pc.iceGatheringState} for session: ${sessionId}`);
    });

    // ICE connection state change
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log('ICE connection state:', pc.iceConnectionState, 'for session:', sessionId);
      
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.sendSessionReadyToWorker(sessionId);
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this.sendSessionFailedToWorker(sessionId, `ICE connection failed: ${pc.iceConnectionState}`);
      }
    });

    // Remote stream handler
    pc.addEventListener('track', (event) => {
      console.log('Received remote track for session:', sessionId);
      const [remoteStream] = event.streams;
      if (remoteStream) {
        sessionState.remoteStream = remoteStream;
        this.handleRemoteStream(sessionId, remoteStream);
      }
    });

    // Connection state change
    pc.addEventListener('connectionstatechange', () => {
      console.log('Connection state:', pc.connectionState, 'for session:', sessionId);
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
  private sendIceCandidateToWorker(sessionId: string, candidate: RTCIceCandidate): void {
    if (this.callbacks?.sendIceCandidate) {
      this.callbacks.sendIceCandidate(sessionId, candidate);
    }
  }

  /**
   * Send session ready to worker
   */
  private sendSessionReadyToWorker(sessionId: string): void {
    if (this.callbacks?.sendSessionReady) {
      this.callbacks.sendSessionReady(sessionId);
    }
  }

  /**
   * Send session failed to worker
   */
  private sendSessionFailedToWorker(sessionId: string, error: string): void {
    if (this.callbacks?.sendSessionFailed) {
      this.callbacks.sendSessionFailed(sessionId, error);
    }
  }

  /**
   * Handle remote stream
   */
  private handleRemoteStream(sessionId: string, stream: MediaStream): void {
    if (this.callbacks?.handleRemoteStream) {
      this.callbacks.handleRemoteStream(sessionId, stream);
    }
  }

  /**
   * Cleanup session
   */
  public cleanupSession(sessionId: string): void {
    const sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      return;
    }

    console.log('Cleaning up session:', sessionId);

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

    this.sessions.delete(sessionId);
  }

  /**
   * Cleanup all sessions
   */
  public cleanup(): void {
    console.log('Cleaning up MediaHandler');
    
    for (const sessionId of this.sessions.keys()) {
      this.cleanupSession(sessionId);
    }
    
    this.sessions.clear();
  }

  /**
   * Get session info for debugging
   */
  public getSessionInfo(sessionId: string): any {
    const sessionState = this.sessions.get(sessionId);
    if (!sessionState) {
      return null;
    }

    return {
      sessionId,
      signalingState: sessionState.peerConnection.signalingState,
      iceConnectionState: sessionState.peerConnection.iceConnectionState,
      connectionState: sessionState.peerConnection.connectionState,
      iceGatheringComplete: sessionState.iceGatheringComplete,
      hasLocalStream: !!sessionState.localStream,
      hasRemoteStream: !!sessionState.remoteStream,
      queuedCandidates: sessionState.iceCandidatesQueue.length
    };
  }
} 