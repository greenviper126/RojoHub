/*
	Updates the panel's DOM to match new HTML by changing only what differs,
	instead of replacing it. Replacing re-created every element on each
	update: an open branch picker replayed its opening animation (a visible
	flash), the connected light's pulse restarted, and hover and scroll
	positions were lost. Kept elements keep all of that.

	Children are matched by key (id, data-key, or a drag list's data-drop-key)
	where they have one, else by position and tag. A focused text box keeps
	what is being typed in it.
*/

function keyOf(node: Node): string | null {
	if (!(node instanceof Element)) return null;
	const id = node.getAttribute("id");
	if (id) return `#${id}`;
	const key = node.getAttribute("data-key");
	if (key) return `k:${key}`;
	const drop = node.getAttribute("data-drop-key");
	return drop ? `d:${node.getAttribute("data-drop-list") ?? ""}:${drop}` : null;
}

function sameKind(a: Node, b: Node): boolean {
	if (a.nodeType !== b.nodeType) return false;
	if (a instanceof Element && b instanceof Element) return a.tagName === b.tagName && keyOf(a) === keyOf(b);
	return true;
}

function patchAttributes(from: Element, to: Element): void {
	for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
	for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

function patchNode(from: Node, to: Node): void {
	if (!(from instanceof Element) || !(to instanceof Element)) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	patchAttributes(from, to);
	patchChildren(from, to);
	// Attributes set an input's starting value only; its live value is a property. A focused box is being typed in.
	if ((from instanceof HTMLInputElement || from instanceof HTMLTextAreaElement) && from !== document.activeElement) {
		const value = (to as HTMLInputElement).getAttribute("value") ?? "";
		if (from.value !== value) from.value = value;
	}
	if (from instanceof HTMLSelectElement) {
		const selected = [...to.querySelectorAll("option")].findIndex((option) => option.hasAttribute("selected"));
		const index = Math.max(0, selected);
		if (from.selectedIndex !== index && from !== document.activeElement) from.selectedIndex = index;
	}
}

function patchChildren(parent: Node, next: Node): void {
	const keyed = new Map<string, Node>();
	for (const child of parent.childNodes) {
		const key = keyOf(child);
		if (key) keyed.set(key, child);
	}
	const kept = new Set<Node>();
	let cursor: ChildNode | null = parent.firstChild;
	for (const fresh of [...next.childNodes]) {
		const key = keyOf(fresh);
		let match: Node | null = null;
		if (key) {
			const candidate = keyed.get(key);
			if (candidate && !kept.has(candidate) && sameKind(candidate, fresh)) match = candidate;
		} else {
			while (cursor && kept.has(cursor)) cursor = cursor.nextSibling;
			if (cursor && !keyOf(cursor) && sameKind(cursor, fresh)) match = cursor;
		}
		if (match) {
			if (match === cursor) cursor = cursor.nextSibling;
			else parent.insertBefore(match, cursor);
			kept.add(match);
			patchNode(match, fresh);
		} else {
			parent.insertBefore(fresh, cursor);
			kept.add(fresh);
		}
	}
	for (const child of [...parent.childNodes]) if (!kept.has(child)) parent.removeChild(child);
}

/** Makes `root`'s children match `html`, keeping every element that is still there. */
export function morph(root: Element, html: string): void {
	const template = document.createElement("template");
	template.innerHTML = html;
	patchChildren(root, template.content);
}
