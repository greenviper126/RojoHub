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

/*
	Versioned docs (spec 017). The root pages describe the current release; each older release is a
	frozen copy under its own folder (site/v0.21/) with its own nav and sidebar, and the nav's
	"Version" menu switches between them (VitePress locales). At a release: copy the previous
	release's pages from its tag into a new folder, add it to `locales`, and set the root label.
*/
const releases = "https://github.com/greenviper126/RojoHub/releases";

const nav = (prefix: string) => [
	{ text: "Guide", link: `${prefix}/guide/getting-started`, activeMatch: `${prefix}/guide/` },
	{ text: "Reference", link: `${prefix}/reference/settings`, activeMatch: `${prefix}/reference/` },
	{ text: "Troubleshooting", link: `${prefix}/troubleshooting` },
	{
		text: "Releases",
		items: [
			{ text: "Changelog", link: `${prefix}/changelog` },
			{ text: "GitHub releases", link: releases },
		],
	},
];

const sidebar = (prefix: string) => [
	{
		text: "Guide",
		items: [
			{ text: "Get started", link: `${prefix}/guide/getting-started` },
			{ text: "Projects", link: `${prefix}/guide/projects` },
			{ text: "Connecting Studio", link: `${prefix}/guide/connecting-studio` },
			{ text: "Switching branches", link: `${prefix}/guide/switching` },
			{ text: "Groups", link: `${prefix}/guide/groups` },
			{ text: "Agents", link: `${prefix}/guide/agents` },
		],
	},
	{
		text: "Reference",
		items: [
			{ text: "Settings", link: `${prefix}/reference/settings` },
			{ text: "Commands", link: `${prefix}/reference/commands` },
			{ text: "Files on disk", link: `${prefix}/reference/files` },
			{ text: "Background service", link: `${prefix}/reference/service` },
			{ text: "Local API", link: `${prefix}/reference/api` },
		],
	},
	{
		text: "Help",
		items: [
			{ text: "Troubleshooting", link: `${prefix}/troubleshooting` },
			{ text: "Changelog", link: `${prefix}/changelog` },
		],
	},
];

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
	locales: {
		root: { label: "0.22.13 (latest)", lang: "en-US" },
		"v0.21": { label: "0.21.0", lang: "en-US", link: "/v0.21/", themeConfig: { nav: nav("/v0.21"), sidebar: sidebar("/v0.21") } },
	},
	themeConfig: {
		logo: "/icon.png",
		nav: nav(""),
		sidebar: sidebar(""),
		langMenuLabel: "Version",
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
