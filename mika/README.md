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

## Konflikte bei Updates (mit KI lösen)

Wenn `Update-T3Mika.ps1` mit „Konflikt in mika/xyz“ stoppt, bleiben der Build und `mika/main` unverändert.
Dann in einem T3-Code-Thread im Projekt `D:\T3-Dev\t3code`:

> Rebase `mika/xyz` auf `main`, löse die Konflikte so, dass die Funktion erhalten bleibt und zu den neuen
> Upstream-Änderungen passt. Danach `vp run check:changed` und die Tests des Branches ausführen, dann
> `mika\Update-T3Mika.ps1 -SkipFetch` starten.
