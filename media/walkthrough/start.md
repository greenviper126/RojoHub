# Start serving

Click **Start** on the project's card in the Rojo-Hub panel.

Rojo-Hub runs `rojo serve` for you, using the Rojo version the project's `rokit.toml` pins. A small background service owns these processes, so they keep running when you close VS Code windows. Projects that were serving come back after a restart.

The card's light shows the state:

| Light | Meaning |
|---|---|
| grey ring | stopped |
| green ring | serving, no Studio connected |
| green dot | serving, Studio connected |
| red dot | error: the card shows the message, and the log button has the rest |
