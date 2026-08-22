const CACHE_NAME = "msu-lms-pwa-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/login.html",
  "/signup.html",
  "/library.html",
  "/student-dashboard.html",
  "/librarian-dashboard.html",
  "/admin-dashboard.html",
  "/scan-book.html",
  "/manifest.json",
  "/assets/mlsu-logo.png",
  "/assets/mlsu-logo-192.png",
  "/assets/mlsu-logo-512.png",
  "/assets/library-shelf-bg.jpg",
  "/assets/book-placeholder.svg",
  "/css/style.css",
  "/css/styles.css",
  "/js/pwa.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((error) => {
            console.warn(`Unable to precache ${asset}`, error);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function shouldBypassCache(request) {
  if (request.method !== "GET") return true;

  const url = new URL(request.url);

  // Keep all third-party SDKs and APIs on the network. This includes Firebase
  // Auth/Firestore, Google APIs, EmailJS, Open Library, and book-cover services.
  if (url.origin !== self.location.origin) return true;

  // Same-origin API responses and Firebase Hosting auth helpers are dynamic.
  return (
    url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/__/")
    || url.pathname.startsWith("/downloads/")
    || url.pathname.endsWith(".apk")
    || url.pathname.includes("/firestore/")
    || url.pathname.includes("/identitytoolkit/")
    || url.pathname.includes("/securetoken/")
  );
}

function isStaticRequest(request) {
  return ["script", "style", "image", "font", "manifest"].includes(request.destination);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (shouldBypassCache(request)) return;

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/index.html"))
        )
    );
    return;
  }

  if (!isStaticRequest(request)) return;

  if (request.destination === "script" || request.destination === "style") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          request.destination === "image"
            ? caches.match("/assets/book-placeholder.svg")
            : Response.error()
        );
    })
  );
});

self.addEventListener("push", (event) => {
  const data = event.data?.json?.() || {
    title: "Mohanlal Sukhadia University LMS",
    body: "You have a library notification."
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Mohanlal Sukhadia University LMS", {
      body: data.body || "You have a library notification.",
      icon: "/assets/mlsu-logo-192.png",
      badge: "/assets/mlsu-logo-192.png"
    })
  );
});
