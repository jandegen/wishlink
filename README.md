# WishLink

Ich möchte eine Applikation auf der Leute ihre Wünsche eintragen können und andere diese sehen, bzw. mitteilen, dass sie etwas schenken werden oder sich beteiligen.

- Als Besitzer eines Wunsches möchte ich einen Titel und Beschreibung sowie einen Link angeben können
- Als Nutzer möchte ich Wünsche anderer sehen können und markieren dass ich diesen SChenken oder mich beteiligen möchte (ggf. sogar schon gekauft)
- Als Nutzer möchte ich sehen, welche anderen Nutzer andere Wünsche bereits markiert haben oder sich beteiligen
- Als Besitzer darf ich niemals sehen, wenn andere Nutzer meine Wünsche markieren, sich beteiligen oder sonst irgendwie damit interagieren.
- JEder Nutzer kann Wünsche anlegen
- Zur Registrierung genügt ein benutzername, vorname, nachname, mail und passwort (ggf. OIDC vorbereitet mittels KEycloak)
- Als Besitzer möchte ich Wünsche priorisieren können um anderen mitzuteilen was ich mir wünsche.
- Als Besitzer möchte ich Wünsche freigeben, so dass sie von anderen gesehen werden, vorher dürfen andere die Wünsche nicht sehen.

Technologie egal, aber
 - Docker Deployable
 - Kubernetes Deployment auf dem lokalen k3s Cluster in der Gitlab CI als DEV umgebung
 - Implementierung auf English
 - Applikation auf Deutsch aber vorbereitet für weitere Sprachen
 - Docker Compose Deployment Anleitung bereitstellen

- _Unit Tests & E2E Tests
- Vollständige GitLab CI inkl. Release Prozess
- Dokumentation für Architektur und Implementierung
---

## Umsetzung

Die Anforderungen oben sind umgesetzt (Node.js + SQLite, Vanilla-JS-Frontend, Deutsch/Englisch).

```bash
docker compose up -d           # aktuelles Release von ghcr.io → http://localhost:3000
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build   # aus dem Quellcode bauen
npm ci && npm run dev          # lokale Entwicklung
npm test && npm run test:e2e   # Unit-/API- und Browser-E2E-Tests
```

- Architektur: [docs/architecture.md](docs/architecture.md)
- Implementierung, API, Konfiguration, Docker Compose, Keycloak, k3s, Release: [docs/implementation.md](docs/implementation.md)
- CI/CD: [.gitlab-ci.yml](.gitlab-ci.yml) · Kubernetes: [k8s/](k8s/)
- Releases & GitHub-Mirror (Source, Images, Artefakte, Releases – ohne Secrets): [docs/release.md](docs/release.md)
