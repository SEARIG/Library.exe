const CACHE_NAME = "mlsu-lms-pwa-v2";

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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(console.warn))
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

function shouldBypassCache(request) {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();

  return (
    request.method !== "GET"
    || url.origin !== self.location.origin
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/__/auth/")
    || url.pathname.startsWith("/__/firebase/")
    || hostname.includes("firebase")
    || hostname.includes("firestore")
    || hostname.includes("googleapis")
    || hostname.includes("identitytoolkit")
    || hostname.includes("securetoken")
    || hostname.includes("emailjs")
    || hostname.includes("openlibrary")
    || hostname.includes("books.google")
    || hostname.includes("gstatic")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (shouldBypassCache(request)) return;

  const accept = request.headers.get("accept") || "";
  const isHtml = request.mode === "navigate"
    || request.destination === "document"
    || accept.includes("text/html");

  if (isHtml) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }))
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
