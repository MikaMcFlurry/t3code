# T3 Code Mika

Mikas eigene T3-Code-Version. Sie läuft parallel zur offiziellen App, hat eigene Daten auf `D:\T3-Mika` und
kann jederzeit zurück auf die offizielle Version.

## Aufbau

| Ort                  | Inhalt                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `D:\T3-Dev\t3code`   | Fork (`origin` = MikaMcFlurry/t3code, `upstream` = pingdotgg/t3code) |
| `D:\T3-Mika\home`    | Daten von T3 Code Mika (wie `~/.t3` bei der offiziellen App)         |
| `D:\T3-Mika\appdata` | Eigenes Electron-Profil, damit beide Apps gleichzeitig laufen können |
| `D:\T3-Mika\backups` | Sicherungen, die die Umzugsskripte vor dem Überschreiben anlegen     |

Branches:

- `main` ist immer exakt upstream `main`, ohne eigene Commits.
- `mika/<feature>`: Ein Branch pro Funktion, jeweils auf upstream `main`. So bleibt jeder einzeln als Pull Request nutzbar.
- `mika/tooling` enthält nur diesen Ordner und wird nie upstream eingereicht.
- `mika/main` wird bei jedem Update neu erzeugt: `main` plus alle Branches aus `branches.txt`. Davon wird gebaut.

## Benutzung

```powershell
# Einmalig: offizielle App beenden, dann Daten übernehmen
D:\T3-Dev\t3code\mika\Move-ToMika.ps1
D:\T3-Dev\t3code\mika\Install-T3MikaShortcut.ps1   # Verknüpfung "T3 Code Mika"

# Upstream-Updates holen, eigene Branches neu aufsetzen, neu bauen
D:\T3-Dev\t3code\mika\Update-T3Mika.ps1

# Zurück zur offiziellen Version (prüft vorher, ob die offizielle Version das DB-Schema kennt)
D:\T3-Dev\t3code\mika\Move-ToOfficial.ps1 -WhatIf   # nur prüfen
D:\T3-Dev\t3code\mika\Move-ToOfficial.ps1
```

Die offizielle App wird von keinem Skript verändert, außer von `Move-ToOfficial.ps1`. Das sichert vorher nach `D:\T3-Mika\backups`.
Worktrees und Projektordner bleiben an ihrem Ort, beide Versionen zeigen auf dieselben Ordner.

### Handy-App: zwei Modi

| Modus                | Befehl                      | Handy                                                   | Gleichzeitig nutzbar     |
| -------------------- | --------------------------- | ------------------------------------------------------- | ------------------------ |
| Übernahme (Standard) | `Move-ToMika.ps1`           | funktioniert unverändert (gleiche Identität, Port 3773) | nein, immer nur eine App |
| Parallel             | `Move-ToMika.ps1 -Parallel` | einmal neu koppeln, danach zwei Rechner in der App      | ja                       |

`Start-T3Mika.ps1` startet im Übernahme-Modus nicht, solange die offizielle App läuft. Zwei Server mit derselben
Identität würden sich sonst den T3-Connect-Tunnel streitig machen.

## Eigene Funktionen

| #   | Funktion                                                                                        | Branch                                      | Wo                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Limit-Kreise (5h / Woche, % übrig) je Account                                                   | `mika/usage-rings`                          | Modell-Auswahl, Account-Leiste links                             |
| 2   | „Auto thread“: Projekt, Modell, Reasoning und Account aus dem Prompt                            | `mika/auto-launch`                          | Stern-Button neben „New thread“                                  |
| 3   | Automatischer Account nach Auslastung                                                           | `mika/auto-model`                           | Einstellungen > Projects > „Automatic account“                   |
| 4   | Routinen/Webhooks: automatischer Account, Modell oder Auto-Routing pro Aufruf, erlaubte Modelle | `mika/routine-auto`, `mika/routine-routing` | Einstellungen > Scheduled tasks; erlaubte Modelle unter Projects |
| 5   | Sprache fürs Diktat (iPhone-App)                                                                | `mika/dictation-locale`                     | iPhone: Settings > Microphone (eigener iOS-Build nötig)          |
| 6   | Zentrale Skills für alle Accounts, auch per KI installierbar                                    | `mika/central-skills`                       | Einstellungen > Providers > „Central skills“                     |
| 7   | Zentrale MCP-Server für alle Claude- und Codex-Sitzungen                                        | `mika/central-mcp`                          | Einstellungen > Providers > „Central MCP servers“                |

Dazu kommt `mika/side-by-side` (eigenes Electron-Profil über `T3CODE_DESKTOP_APP_DATA_DIR`). Claude.ai-Konnektoren
wie Gmail oder Drive hängen am claude.ai-Konto und lassen sich nicht zentral teilen. Ersatz sind lokale MCP-Server (7).

### Routine von der eigenen Webseite starten

1. In T3 Code Mika unter Einstellungen > Scheduled tasks eine Aufgabe mit dem Auslöser **Webhook** anlegen.
   Der Prompt kann Platzhalter aus dem Request-Body verwenden; die Hilfe im Formular zeigt die Syntax.
2. Die angezeigte Webhook-Adresse kopieren. Mit T3 Connect ist sie über das Internet erreichbar, ohne offenen Port.
3. Von der Webseite (serverseitig, die Adresse ist geheim) aufrufen:

```js
await fetch(process.env.T3_WEBHOOK_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ task: "Prüfe die Kontaktformulare und berichte Fehler" }),
});
```

#### Modell pro Aufruf wählen oder automatisch routen

Der Body darf ein Objekt `t3` enthalten, alle Felder sind optional:

```json
{
  "task": "Prüfe die Kontaktformulare",
  "t3": {
    "routing": "auto",
    "allowed": ["driver:codex", "claude-2/claude-opus-5-5"],
    "effort": "high"
  }
}
```

| Feld               | Wirkung                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `model`            | Fest dieses Modell, z. B. `"codex-business-3/gpt-6.1-sol"` (Account-ID/Modell)                         |
| `routing: "auto"`  | Aufgabengröße aus dem Prompt, dann passendes Modell auf dem Account mit der meisten Restkapazität      |
| `routing: "fixed"` | Gespeichertes Modell der Routine, ohne automatischen Account                                           |
| `allowed`          | Engt die erlaubten Modelle für diesen Aufruf ein (kann die Einstellung nur verkleinern, nie erweitern) |
| `effort`           | Reasoning-Stufe, z. B. `low`, `medium`, `high`, wenn das Modell sie kennt                              |

Ohne `t3` gilt: Ist „Automatic account“ aktiv, startet der Lauf auf dem Account mit der meisten Restkapazität,
sonst mit dem gespeicherten Modell. Die erlaubten Modelle stellst du in Einstellungen > Projects >
„Allowed models for automatic routing“ ein (Account-ID, `Account/Modell` oder `driver:codex`). Sie gelten für jede
automatische Wahl: neue Threads, Auto thread und Routinen. Die Account-IDs stehen in Einstellungen > Providers.

## Konflikte bei Updates (mit KI lösen)

Wenn `Update-T3Mika.ps1` mit „Konflikt in mika/xyz“ stoppt, bleiben der Build und `mika/main` unverändert.
Dann in einem T3-Code-Thread im Projekt `D:\T3-Dev\t3code`:

> Rebase `mika/xyz` auf `main`, löse die Konflikte so, dass die Funktion erhalten bleibt und zu den neuen
> Upstream-Änderungen passt. Danach `vp run check:changed` und die Tests des Branches ausführen, dann
> `mika\Update-T3Mika.ps1 -SkipFetch` starten.
