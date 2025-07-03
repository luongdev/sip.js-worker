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
 * MediaHandler class để xử lý các media requests từ worker
 */
export class MediaHandler {
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private localStreams: Map<string, MediaStream> = new Map();
  private iceCandidateQueue: Map<string, RTCIceCandidateInit[]> = new Map();
  private callbacks: MediaHandlerCallbacks | null = null;

  /**
   * Khởi tạo MediaHandler
   */
  constructor(callbacks?: MediaHandlerCallbacks) {
    this.callbacks = callbacks || null;
    console.log('MediaHandler initialized');
  }

  /**
   * Set callbacks cho MediaHandler
   */
  public setCallbacks(callbacks: MediaHandlerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Xử lý media request từ worker
   * @param request Media request
   * @returns Media response
   */
  public async handleMediaRequest(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    console.log('Handling media request:', request);

    try {
      switch (request.type) {
        case 'offer':
          return await this.createOffer(request);
        case 'answer':
          return await this.createAnswer(request);
        case 'set-remote-sdp':
          return await this.setRemoteDescription(request);
        case 'ice-candidate':
          return await this.addIceCandidate(request);
        default:
          throw new Error(`Unsupported media request type: ${request.type}`);
      }
    } catch (error: any) {
      console.error('Media request failed:', error);
      return {
        sessionId: request.sessionId,
        success: false,
        error: error.message || 'Unknown media error'
      };
    }
  }

  /**
   * Tạo offer SDP
   */
  private async createOffer(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, constraints } = request;

    // Tạo PeerConnection mới
    const peerConnection = this.createPeerConnection(sessionId);

    // Lấy user media stream
    const stream = await this.getUserMedia(constraints || { audio: true, video: false });
    this.localStreams.set(sessionId, stream);

    // Thêm tracks vào PeerConnection
    stream.getTracks().forEach(track => {
      peerConnection.addTrack(track, stream);
    });

    // Tạo offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    console.log('Created offer for session:', sessionId);

    return {
      sessionId,
      success: true,
      sdp: offer.sdp
    };
  }

  /**
   * Tạo answer SDP
   */
  private async createAnswer(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, constraints } = request;

    const peerConnection = this.peerConnections.get(sessionId);
    if (!peerConnection) {
      throw new Error(`No PeerConnection found for session: ${sessionId}`);
    }

    // Lấy user media stream nếu chưa có
    if (!this.localStreams.has(sessionId)) {
      const stream = await this.getUserMedia(constraints || { audio: true, video: false });
      this.localStreams.set(sessionId, stream);

      // Thêm tracks vào PeerConnection
      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
      });
    }

    // Tạo answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    console.log('Created answer for session:', sessionId);

    return {
      sessionId,
      success: true,
      sdp: answer.sdp
    };
  }

  /**
   * Set remote description
   */
  private async setRemoteDescription(request: SipWorker.MediaRequest): Promise<SipWorker.MediaResponse> {
    const { sessionId, sdp } = request;

    if (!sdp) {
      throw new Error('SDP is required for set-remote-sdp request');
    }

    let peerConnection = this.peerConnections.get(sessionId);
    if (!peerConnection) {
      // Tạo PeerConnection mới nếu chưa có (incoming call)
      peerConnection = this.createPeerConnection(sessionId);
    }

    // Set remote description
    await peerConnection.setRemoteDescription({
      type: sdp.includes('a=sendrecv') ? 'offer' : 'answer',
      sdp: sdp
    });

    // Process queued ICE candidates
    const queuedCandidates = this.iceCandidateQueue.get(sessionId) || [];
    for (const candidate of queuedCandidates) {
      await peerConnection.addIceCandidate(candidate);
    }
    this.iceCandidateQueue.delete(sessionId);

    console.log('Set remote description for session:', sessionId);

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

    const peerConnection = this.peerConnections.get(sessionId);
    if (!peerConnection) {
      // Queue candidate if PeerConnection not ready yet
      if (!this.iceCandidateQueue.has(sessionId)) {
        this.iceCandidateQueue.set(sessionId, []);
      }
      this.iceCandidateQueue.get(sessionId)!.push(candidate);
      console.log('Queued ICE candidate for session:', sessionId);
    } else {
      await peerConnection.addIceCandidate(candidate);
      console.log('Added ICE candidate for session:', sessionId);
    }

    return {
      sessionId,
      success: true
    };
  }

  /**
   * Tạo PeerConnection mới
   */
  private createPeerConnection(sessionId: string): RTCPeerConnection {
    const configuration: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const peerConnection = new RTCPeerConnection(configuration);

    // Setup event listeners
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        // Send ICE candidate to worker
        this.sendIceCandidateToWorker(sessionId, event.candidate);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log(`PeerConnection state for ${sessionId}:`, peerConnection.connectionState);
      
      if (peerConnection.connectionState === 'connected') {
        this.sendSessionReadyToWorker(sessionId);
      } else if (peerConnection.connectionState === 'failed') {
        this.sendSessionFailedToWorker(sessionId, 'PeerConnection failed');
      }
    };

    peerConnection.ontrack = (event) => {
      console.log('Received remote track for session:', sessionId);
      // Handle remote media stream
      this.handleRemoteStream(sessionId, event.streams[0]);
    };

    this.peerConnections.set(sessionId, peerConnection);
    return peerConnection;
  }

  /**
   * Lấy user media
   */
  private async getUserMedia(constraints: SipWorker.MediaConstraints): Promise<MediaStream> {
    const mediaConstraints: MediaStreamConstraints = {
      audio: constraints.audio || true,
      video: constraints.video || false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      console.log('Got user media:', stream.getTracks().map(t => t.kind));
      return stream;
    } catch (error: any) {
      console.error('Failed to get user media:', error);
      throw new Error(`Failed to get user media: ${error.message}`);
    }
  }

  /**
   * Gửi ICE candidate đến worker
   */
  private sendIceCandidateToWorker(sessionId: string, candidate: RTCIceCandidate): void {
    if (this.callbacks?.sendIceCandidate) {
      this.callbacks.sendIceCandidate(sessionId, candidate);
    } else {
      console.log('Should send ICE candidate to worker:', { sessionId, candidate });
    }
  }

  /**
   * Gửi session ready đến worker
   */
  private sendSessionReadyToWorker(sessionId: string): void {
    if (this.callbacks?.sendSessionReady) {
      this.callbacks.sendSessionReady(sessionId);
    } else {
      console.log('Should send session ready to worker:', sessionId);
    }
  }

  /**
   * Gửi session failed đến worker
   */
  private sendSessionFailedToWorker(sessionId: string, error: string): void {
    if (this.callbacks?.sendSessionFailed) {
      this.callbacks.sendSessionFailed(sessionId, error);
    } else {
      console.log('Should send session failed to worker:', { sessionId, error });
    }
  }

  /**
   * Xử lý remote stream
   */
  private handleRemoteStream(sessionId: string, stream: MediaStream): void {
    if (this.callbacks?.handleRemoteStream) {
      this.callbacks.handleRemoteStream(sessionId, stream);
    } else {
      console.log('Handling remote stream for session:', sessionId, stream);
    }
  }

  /**
   * Cleanup session
   */
  public cleanupSession(sessionId: string): void {
    console.log('Cleaning up session:', sessionId);

    // Close PeerConnection
    const peerConnection = this.peerConnections.get(sessionId);
    if (peerConnection) {
      peerConnection.close();
      this.peerConnections.delete(sessionId);
    }

    // Stop local stream
    const localStream = this.localStreams.get(sessionId);
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      this.localStreams.delete(sessionId);
    }

    // Clear ICE candidate queue
    this.iceCandidateQueue.delete(sessionId);
  }

  /**
   * Cleanup all sessions
   */
  public cleanup(): void {
    console.log('Cleaning up all media sessions');
    
    for (const sessionId of this.peerConnections.keys()) {
      this.cleanupSession(sessionId);
    }
  }
} 