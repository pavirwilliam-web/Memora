// Service worker Memora — reçoit les notifications push envoyées par le serveur et les
// affiche, même quand le site n'est pas ouvert au premier plan.
// Ce fichier doit être placé dans le dossier "public/" du serveur (à côté de index.html),
// pour être accessible à l'adresse /sw.js.

self.addEventListener('push', (event) => {
  let data = { title: 'Memora', body: 'Nouvelle notification.' };
  try { if (event.data) data = event.data.json(); } catch (e) { /* payload non-JSON, on garde les valeurs par défaut */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Memora', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'memora',
      data: { url: '/' },
    })
  );
});

// Clic sur la notification : ramène au site (ou ouvre un nouvel onglet s'il est fermé).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
