/** One step of a sequence diff: keep, remove or add an element (indexes into the old and new sequences). */
export type Op = { op: "=" | "-" | "+"; a?: number; b?: number };

/**
 * Myers' shortest edit script between two sequences, after trimming their common start and end.
 * Undefined when more than `maxEdits` elements changed, so a rewrite does not cost unbounded time.
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean = (x, y) => x === y, maxEdits = 2000): Op[] | undefined {
	let head = 0;
	while (head < a.length && head < b.length && equal(a[head]!, b[head]!)) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && equal(a[a.length - 1 - tail]!, b[b.length - 1 - tail]!)) tail++;
	const n = a.length - head - tail, m = b.length - head - tail, max = n + m, offset = max + 1;
	const v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
	let edits = -1;
	search: for (let d = 0; d <= Math.min(max, maxEdits); d++) {
		// v as it was before step d, for k from -d to d.
		trace.push(v.slice(offset - d, offset + d + 1));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1, y = x - k;
			while (x < n && y < m && equal(a[head + x]!, b[head + y]!)) { x++; y++; }
			v[offset + k] = x;
			if (x >= n && y >= m) { edits = d; break search; }
		}
	}
	if (edits < 0) return undefined;
	const middle: Op[] = [];
	let x = n, y = m;
	for (let d = edits; d > 0; d--) {
		const before = trace[d]!, at = (k: number) => before[k + d]!, k = x - y;
		const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const px = at(previous), py = px - previous;
		while (x > px && y > py) { x--; y--; middle.push({ op: "=", a: head + x, b: head + y }); }
		middle.push(x === px ? { op: "+", b: head + py } : { op: "-", a: head + px });
		x = px; y = py;
	}
	while (x > 0 && y > 0) { x--; y--; middle.push({ op: "=", a: head + x, b: head + y }); }
	middle.reverse();
	return [...Array.from({ length: head }, (_, index): Op => ({ op: "=", a: index, b: index })), ...middle,
		...Array.from({ length: tail }, (_, index): Op => ({ op: "=", a: a.length - tail + index, b: b.length - tail + index }))];
}

/**
 * A line diff in the format Pi's edit tool uses ("+ 12 text", "- 12 text", "  12 text", "    ..." between hunks),
 * with `context` unchanged lines around each change. Undefined when nothing changed or the change is too large.
 */
export function lineDiff(before: string, after: string, context = 3, maxLines = 400): { text: string; added: number; removed: number; truncated: boolean } | undefined {
	const a = before.split(/\r?\n/), b = after.split(/\r?\n/), ops = diffSequences(a, b);
	if (!ops) return undefined;
	const added = ops.filter(op => op.op === "+").length, removed = ops.filter(op => op.op === "-").length;
	if (!added && !removed) return undefined;
	const width = String(Math.max(a.length, b.length)).length, keep = new Set<number>();
	ops.forEach((op, index) => { if (op.op !== "=") for (let near = index - context; near <= index + context; near++) keep.add(near); });
	const lines: string[] = [];
	let skipped = false;
	ops.forEach((op, index) => {
		if (!keep.has(index)) { skipped = true; return; }
		if (skipped && lines.length) lines.push(`${" ".repeat(width + 1)} ...`);
		skipped = false;
		const number = String((op.op === "-" ? op.a! : op.b!) + 1).padStart(width);
		lines.push(`${op.op === "=" ? " " : op.op}${number} ${op.op === "-" ? a[op.a!] : b[op.b!]}`);
	});
	return { text: lines.slice(0, maxLines).join("\n"), added, removed, truncated: lines.length > maxLines };
}
