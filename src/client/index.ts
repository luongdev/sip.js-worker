// Client entry point
import { VERSION, SipWorker } from '../common/types';
import { SipWorkerClient } from './sip-worker-client';
import { MediaHandler, MediaHandlerCallbacks } from './media-handler';

console.log('SIP Worker Client initialized');

// Để tránh tree-shaking, tạo reference đến classes
const _preventTreeShaking = {
  SipWorkerClient,
  MediaHandler
};

export { 
  VERSION, 
  SipWorker, 
  SipWorkerClient, 
  MediaHandler
};

export type { MediaHandlerCallbacks }; 