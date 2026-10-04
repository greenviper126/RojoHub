import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vitepress";

/*
	The documentation site. Built by `npm run docs:build` into site/.vitepress/dist
	(gitignored) and published to GitHub Pages by CI, never committed.
	Screenshots live in site/public/images (hand-made with tools/panel-preview.html).
	The logo and icon come straight from media/, so there is one copy of each:
	served by the dev server below and copied into the build by buildEnd.
*/

const media = fileURLToPath(new URL("../../media", import.meta.url));
const fromMedia = ["icon.png", "logo.png"];

const mediaFiles: Plugin = {
	name: "rojo-hub-media",
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			const file = fromMedia.find((name) => request.url?.split("?")[0].endsWith(`/${name}`));
			if (!file) return next();
			response.setHeader("Content-Type", "image/png");
			response.end(readFileSync(join(media, file)));
		});
	},
};

export default defineConfig({
	title: "Rojo-Hub",
	description: "Serve many Rojo projects on fixed ports and switch any of them between branches without Studio disconnecting. Built for agents.",
	base: "/RojoHub/",
	cleanUrls: true,
	lastUpdated: false,
	head: [
		["link", { rel: "icon", type: "image/png", href: "/RojoHub/icon.png" }],
		["meta", { name: "theme-color", content: "#e0413c" }],
	],
	vite: { plugins: [mediaFiles] },
	buildEnd(site) {
		for (const name of fromMedia) copyFileSync(join(media, name), join(site.outDir, name));
	},
	themeConfig: {
		logo: "/icon.png",
		nav: [
			{ text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
			{ text: "Reference", link: "/reference/settings", activeMatch: "/reference/" },
			{ text: "Troubleshooting", link: "/troubleshooting" },
			{
				text: "0.21.0",
				items: [
					{ text: "Changelog", link: "/changelog" },
					{ text: "Releases", link: "https://github.com/greenviper126/RojoHub/releases" },
				],
			},
		],
		sidebar: [
			{
				text: "Guide",
				items: [
					{ text: "Get started", link: "/guide/getting-started" },
					{ text: "Projects", link: "/guide/projects" },
					{ text: "Connecting Studio", link: "/guide/connecting-studio" },
					{ text: "Switching branches", link: "/guide/switching" },
					{ text: "Groups", link: "/guide/groups" },
					{ text: "Agents", link: "/guide/agents" },
				],
			},
			{
				text: "Reference",
				items: [
					{ text: "Settings", link: "/reference/settings" },
					{ text: "Commands", link: "/reference/commands" },
					{ text: "Files on disk", link: "/reference/files" },
					{ text: "Background service", link: "/reference/service" },
					{ text: "Local API", link: "/reference/api" },
				],
			},
			{
				text: "Help",
				items: [
					{ text: "Troubleshooting", link: "/troubleshooting" },
					{ text: "Changelog", link: "/changelog" },
				],
			},
		],
		outline: { level: [2, 3] },
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: "https://github.com/greenviper126/RojoHub" }],
		editLink: {
			pattern: "https://github.com/greenviper126/RojoHub/edit/main/site/:path",
			text: "Edit this page on GitHub",
		},
		footer: { message: "Released under the MIT License. Not affiliated with Roblox or the Rojo project." },
	},
});
