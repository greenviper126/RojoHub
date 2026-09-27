import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { FromPanel, PanelState, ToPanel } from "../common/panel";

/*
	Hosts the sidebar panel: a webview (src/webview/main.ts, bundled to
	dist/webview.js) drawn with VS Code's own theme colours and icons. It holds
	no state of its own; the extension sends it everything to show and handles
	every button through onMessage.
*/
export class HubPanel implements vscode.WebviewViewProvider {
	static readonly viewId = "rojoHub.panel";
	private view: vscode.WebviewView | null = null;
	private lastState: PanelState | null = null;
	private pendingFocus: string | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onMessage: (message: FromPanel) => unknown,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, "media");
		const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
		view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((message: FromPanel) => {
			if (message.type === "ready") {
				if (this.lastState) this.post({ type: "state", state: this.lastState });
				if (this.pendingFocus) this.post({ type: "focus", id: this.pendingFocus });
				this.pendingFocus = null;
			}
			void this.onMessage(message);
		});
		view.onDidDispose(() => (this.view = null));
	}

	post(message: ToPanel): void {
		void this.view?.webview.postMessage(message);
	}

	/** Sends new state, but only when something changed, so the panel does not redraw for nothing. */
	update(state: PanelState): void {
		if (this.lastState && JSON.stringify(this.lastState) === JSON.stringify(state)) return;
		this.lastState = state;
		this.post({ type: "state", state });
	}

	/** Opens the sidebar and scrolls the panel to one project. */
	async focus(slotId: string): Promise<void> {
		await vscode.commands.executeCommand(`${HubPanel.viewId}.focus`);
		if (this.view) this.post({ type: "focus", id: slotId });
		else this.pendingFocus = slotId;
	}

	/** Shows VS Code's progress bar across the top of the panel while `work` runs. */
	progress<T>(work: () => Promise<T>): Promise<T> {
		return Promise.resolve(vscode.window.withProgress({ location: { viewId: HubPanel.viewId } }, work));
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString("base64");
		const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...path)).toString();
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("dist", "codicons", "codicon.css")}">
<link rel="stylesheet" href="${asset("media", "panel.css")}">
<title>Rojo-Hub</title>
</head>
<body>
<div id="app" aria-live="polite"><p class="loading">Connecting to Rojo-Hub…</p></div>
<script nonce="${nonce}" src="${asset("dist", "webview.js")}"></script>
</body>
</html>`;
	}
}
