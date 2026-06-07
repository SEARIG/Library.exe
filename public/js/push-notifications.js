const SERVICE_WORKER_PATH = "/service-worker.js";

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.log("Service workers are not supported in this browser.");
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
    console.log("MLSU Library service worker registered:", registration.scope);
    return registration;
  } catch (error) {
    console.error("Service worker registration failed:", error);
    return null;
  }
}

export async function requestPushPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  if (Notification.permission === "granted") {
    return "granted";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  return Notification.requestPermission();
}

export async function preparePushNotifications() {
  const registration = await registerServiceWorker();
  return {
    registration,
    supported: Boolean(registration) && "PushManager" in window
  };
}

// Future FCM path:
// 1. Add Firebase Messaging SDK.
// 2. Request notification permission after user action.
// 3. Create a VAPID key in Firebase Console.
// 4. Store each user's FCM token in Firestore.
// 5. Send push notifications from a trusted backend or Cloud Function.

preparePushNotifications();
