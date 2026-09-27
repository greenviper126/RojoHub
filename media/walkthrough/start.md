# Start serving

Click the ▶ next to a project, or pick it in **Rojo-Hub: Open Menu** and choose **Start Serving**.

Rojo-Hub runs `rojo serve` for you, using the Rojo version the project's `rokit.toml` pins. A small background service owns these processes, so they keep running when you close VS Code windows. Projects that were serving come back after a restart.

The icon shows the state:

| Icon | Meaning |
|---|---|
| ⊘ | stopped |
| ○ (green) | serving, no Studio connected |
| ● (green) | serving, Studio connected |
| ✖ | error: hover it or open **Show Rojo Log** |
