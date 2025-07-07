/**
 * SIP Notifications ServiceWorker
 * Handles push notifications for incoming SIP calls when all tabs are hidden
 */

// Listen for messages from clients
self.addEventListener('message', (event) => {
  const { data, source } = event;
  
  if (data.type === 'REGISTER_FOR_NOTIFICATIONS') {
    console.log('ServiceWorker: Tab registered for notifications');
    // Can store client reference if needed
  }
});

// BroadcastChannel for communication with SharedWorker
const notificationChannel = new BroadcastChannel('sip-notifications');

// Listen for notification requests from SharedWorker
notificationChannel.addEventListener('message', async (event) => {
  const { type, callId, callerInfo, timestamp } = event.data;
  
  console.log('ServiceWorker: Received message from SharedWorker:', event.data);
  
  if (type === 'SHOW_CALL_NOTIFICATION') {
    await showCallNotification(callId, callerInfo);
  }
});

/**
 * Show incoming call notification
 */
async function showCallNotification(callId, callerInfo) {
  try {
    const notificationOptions = {
      body: `Incoming call from ${callerInfo.displayName || callerInfo.uri}`,
      icon: '/icons/phone-icon-192.png',
      badge: '/icons/badge-icon-72.png',
      actions: [
        {
          action: 'answer',
          title: 'Answer',
          icon: '/icons/answer-icon-32.png'
        },
        {
          action: 'reject', 
          title: 'Reject',
          icon: '/icons/reject-icon-32.png'
        }
      ],
      requireInteraction: true, // Don't auto-dismiss
      tag: `sip-call-${callId}`, // Replace previous notifications with same tag
      data: { 
        callId, 
        callerInfo,
        timestamp: Date.now() 
      },
      vibrate: [200, 100, 200, 100, 200], // Vibration pattern for mobile
      silent: false,
      renotify: true // Show notification even if same tag exists
    };
    
    const registration = await self.registration;
    await registration.showNotification('Incoming SIP Call', notificationOptions);
    
    console.log(`ServiceWorker: Notification shown for call ${callId}`);
    
  } catch (error) {
    console.error('ServiceWorker: Failed to show notification:', error);
  }
}

/**
 * Handle notification clicks
 */
self.addEventListener('notificationclick', async (event) => {
  console.log('ServiceWorker: Notification clicked');
  console.log('Event action:', event.action);
  console.log('Event notification:', event.notification);
  console.log('Event notification data:', event.notification.data);
  
  event.notification.close();
  
  // If user clicked notification body (not button), default to answer
  let action = event.action || 'answer';
  const { callId, callerInfo } = event.notification.data;
  
  console.log('Final action:', action, 'callId:', callId);
  
     event.waitUntil(
     clients.matchAll({ type: 'window', includeUncontrolled: true })
       .then(async clientList => {
         console.log('Open clients:', clientList.map(client => client.url));
         
         let targetClient = null;
         
         // Try to focus existing client
         for (const client of clientList) {
           if ('focus' in client) {
             try {
               await client.focus();
               targetClient = client;
               break;
             } catch (error) {
               console.error('Error focusing client:', error);
             }
           }
         }
         
         // Open new window if no existing client
         if (!targetClient && clients.openWindow) {
           targetClient = await clients.openWindow('http://localhost:5173/');
         }
         
         // Send action ONLY to SharedWorker via BroadcastChannel
         // Use different message type to avoid conflict with client
         notificationChannel.postMessage({
           type: 'SW_NOTIFICATION_ACTION',
           action,
           callId,
           timestamp: Date.now()
         });
         
        //  setTimeout(() => {
           notificationChannel.postMessage({
             type: 'REQUEST_STATE_SYNC',
             callId,
             reason: 'notification_action_processed',
             timestamp: Date.now()
           });
        //  }, 200); // 200ms delay for action processing
         
         // Optional: Send to client only for UI feedback (don't process action)
         if (targetClient) {
           targetClient.postMessage({
             type: 'NOTIFICATION_UI_FEEDBACK',
             action,
             callId,
             callerInfo
           });
         }
         
         console.log(`ServiceWorker: Sent action '${action}' for call ${callId}`);
       })
       .catch(err => console.error('Error in notificationclick handler:', err))
   );

});

/**
 * Handle notification close events
 */
self.addEventListener('notificationclose', (event) => {
  const { callId } = event.notification.data;
  console.log(`ServiceWorker: Notification closed for call ${callId}`);
});

/**
 * ServiceWorker activation
 */
self.addEventListener('activate', (event) => {
  console.log('ServiceWorker: SIP Notifications ServiceWorker activated');
  event.waitUntil(self.clients.claim());
});

/**
 * ServiceWorker installation
 */
self.addEventListener('install', (event) => {
  console.log('ServiceWorker: SIP Notifications ServiceWorker installed');
  self.skipWaiting();
});

/**
 * Background sync for maintaining notifications (optional)
 */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sip-notification-sync') {
    event.waitUntil(syncNotificationState());
  }
});

async function syncNotificationState() {
  try {
    // Could sync with server or clean up old notifications
    const notifications = await self.registration.getNotifications();
    console.log(`ServiceWorker: Found ${notifications.length} active notifications`);
    
    // Close notifications older than 30 seconds
    const now = Date.now();
    notifications.forEach(notification => {
      const notificationTime = notification.data?.timestamp || 0;
      if (now - notificationTime > 30000) { // 30 seconds
        notification.close();
        console.log(`ServiceWorker: Closed old notification for call ${notification.data?.callId}`);
      }
    });
    
  } catch (error) {
    console.error('ServiceWorker: Error syncing notification state:', error);
  }
}

console.log('ServiceWorker: SIP Notifications ServiceWorker script loaded'); 