const CACHE_NAME = "mlsu-library-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/login.html",
  "/signup.html",
  "/css/style.css",
  "/assets/book-placeholder.svg"
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
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener("push", (event) => {
  const data = event.data?.json?.() || {
    title: "MLSU Library",
    body: "You have a library notification."
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "MLSU Library", {
      body: data.body || "You have a library notification.",
      icon: "/assets/book-placeholder.svg",
      badge: "/assets/book-placeholder.svg"
    })
  );
});
