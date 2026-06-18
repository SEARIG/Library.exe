const CACHE_NAME = "mlsu-library-v8";
const APP_SHELL = [
  "/",
  "/index.html",
  "/login.html",
  "/signup.html",
  "/library.html",
  "/student-dashboard.html",
  "/librarian-dashboard.html",
  "/admin-dashboard.html",
  "/scan-book.html",
  "/css/style.css?v=6",
  "/js/pwa.js?v=6",
  "/assets/book-placeholder.svg",
  "/assets/mlsu-logo-192.png",
  "/assets/mlsu-logo-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  if (
    event.request.url.startsWith(self.location.origin)
    && ["script", "style", "manifest"].includes(event.request.destination)
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && event.request.url.startsWith(self.location.origin)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
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
