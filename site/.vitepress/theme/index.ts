// The default theme, with Rojo-Hub's logo colours (red and amber) as the brand colours, and a bar on
// the frozen docs of an older release (site/v0.21/, spec 017) saying which version they describe.
import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import { useData, withBase } from "vitepress";

import "./custom.css";

/** The folders of frozen releases under site/, and the version each one describes. */
const frozen: Record<string, string> = { "v0.21/": "0.21.0" };

export default {
	extends: DefaultTheme,
	Layout() {
		const { page } = useData();
		const folder = Object.keys(frozen).find((prefix) => page.value.relativePath.startsWith(prefix));
		return h(DefaultTheme.Layout, null, {
			"layout-top": () =>
				folder
					? h("div", { class: "frozen-docs" }, [
							`These pages describe Rojo-Hub ${frozen[folder]}.`,
							h("a", { href: withBase("/") }, "Read the current docs"),
						])
					: null,
		});
	},
};
