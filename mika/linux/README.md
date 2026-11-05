# T3 Mika auf Linux (iMacs)

Laeuft als `t3mika.service` (siehe `~/T3-Mika/bin/t3-variante`). Updates:

- `t3mika-update` holt `mika/main` aus dem Fork, baut neben der laufenden Version unter
  `~/T3-Mika/releases/<commit>` und schaltet `~/T3-Mika/current` erst um, wenn keine Turns laufen.
  Bei einem ungesunden Start geht es automatisch auf den vorherigen Build zurueck.
- `t3mika-update.timer` ruft das alle 30 Minuten auf. Log: `~/T3-Mika/logs/t3mika-update.log`.

Einrichten (ohne sudo):

    install -m 755 t3mika-update ~/T3-Mika/bin/
    install -m 644 t3mika-update.service t3mika-update.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now t3mika-update.timer
