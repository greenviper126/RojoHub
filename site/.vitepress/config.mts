import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

/*
	The documentation site. Built by `npm run docs:build` into site/.vitepress/dist
	(gitignored) and published to GitHub Pages by CI, never committed.
	The logo and icon come straight from media/, so there is one copy of each.
*/

export default defineConfig({
	title: "Rojo-Hub",
	description: "Serve many Rojo projects on fixed ports and switch any of them between branches without Studio disconnecting.",
	base: "/RojoHub/",
	cleanUrls: true,
	lastUpdated: false,
	head: [["link", { rel: "icon", type: "image/png", href: "/RojoHub/icon.png" }]],
	vite: {
		publicDir: fileURLToPath(new URL("../../media", import.meta.url)),
	},
	themeConfig: {
		logo: "/icon.png",
		nav: [
			{ text: "Guide", link: "/guide/requirements", activeMatch: "/guide/" },
			{ text: "Reference", link: "/reference/settings", activeMatch: "/reference/" },
			{ text: "Troubleshooting", link: "/troubleshooting" },
		],
		sidebar: [
			{
				text: "Getting started",
				items: [
					{ text: "Requirements", link: "/guide/requirements" },
					{ text: "Install", link: "/guide/install" },
					{ text: "Your first project", link: "/guide/first-project" },
				],
			},
			{
				text: "Guide",
				items: [
					{ text: "Switching branches", link: "/guide/switching" },
					{ text: "Ports", link: "/guide/ports" },
				],
			},
			{
				text: "Reference",
				items: [{ text: "Settings", link: "/reference/settings" }],
			},
			{ text: "Troubleshooting", link: "/troubleshooting" },
		],
		outline: { level: [2, 3] },
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: "https://github.com/greenviper126/RojoHub" }],
		editLink: {
			pattern: "https://github.com/greenviper126/RojoHub/edit/main/site/:path",
			text: "Edit this page on GitHub",
		},
		footer: { message: "Not affiliated with Roblox or the Rojo project." },
	},
});
