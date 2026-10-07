/**
 * The report.
 *
 * A cycle is only useful if a human can read what happened and decide whether to
 * believe it. Everything model-authored — motivations, mechanisms, summaries —
 * is escaped before it reaches the HTML: the report is a document about
 * untrusted text, not a place to render it.
 */

import * as path from 'node:path'
import type { FileSystem } from '../fs.ts'
import type { OpResult } from '../result.ts'
import { ok } from '../result.ts'
import type { TunerReport } from './types.ts'

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderReport(report: TunerReport): string {
	const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

	const branchRows: string[] = []
	for (const cycle of report.cycles) {
		for (const branch of cycle.branches) {
			const note =
				branch.invalidReason ?? (branch.contractViolations.length > 0 ? branch.contractViolations.join('; ') : branch.verdictReasons.join('; '))
			branchRows.push(
				[
					'<tr>',
					`<td>${String(cycle.cycle)}</td>`,
					`<td>${escapeHtml(branch.branchId)}</td>`,
					`<td>${escapeHtml(branch.valid ? branch.verdict : 'invalid')}</td>`,
					`<td>${percent(branch.optimizationScore)}</td>`,
					`<td>${escapeHtml(note)}</td>`,
					'</tr>',
				].join(''),
			)
		}
	}

	const cycleRows: string[] = report.cycles.map((cycle) =>
		[
			'<tr>',
			`<td>${String(cycle.cycle)}</td>`,
			`<td>${percent(cycle.baselineScore)}</td>`,
			`<td>${String(cycle.branches.length)}</td>`,
			`<td>${cycle.promoted ? 'promoted' : 'not promoted'}</td>`,
			`<td>${cycle.heldOut === null ? '—' : `${percent(cycle.heldOut.baselineScore)} → ${percent(cycle.heldOut.candidateScore)} (${escapeHtml(cycle.heldOut.verdict)})`}</td>`,
			`<td>$${cycle.costUsd.toFixed(4)}</td>`,
			'</tr>',
		].join(''),
	)

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tuner report</title></head>
<body>
<h1>Tuner report</h1>
<p><strong>Stopped because:</strong> ${escapeHtml(report.terminatedBy)}</p>
<p><strong>Spend:</strong> $${report.costUsd.toFixed(4)} &middot; <strong>Guild:</strong> ${escapeHtml(report.guildPath)}</p>
<p><strong>From</strong> ${escapeHtml(report.startedAt)} <strong>to</strong> ${escapeHtml(report.finishedAt)}</p>

<h2>Cycles</h2>
<table border="1" cellpadding="4">
<thead><tr><th>#</th><th>baseline</th><th>hypotheses</th><th>outcome</th><th>held-out</th><th>cost</th></tr></thead>
<tbody>${cycleRows.join('')}</tbody>
</table>

<h2>Hypotheses</h2>
<table border="1" cellpadding="4">
<thead><tr><th>cycle</th><th>id</th><th>verdict</th><th>optimization</th><th>why</th></tr></thead>
<tbody>${branchRows.join('')}</tbody>
</table>

<h2>Promoted baselines</h2>
<ol>${report.history.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('') || '<li>none</li>'}</ol>
</body>
</html>
`
}

/** Writes `summary.json` and `index.html` into a timestamped report directory. */
export function writeReport(
	dependencies: { readonly fs: FileSystem },
	workspacePath: string,
	report: TunerReport,
): OpResult<string> {
	const entry = report.finishedAt.replace(/[:.]/g, '-')
	const directory = path.join(workspacePath, 'reports', entry)
	dependencies.fs.ensureDirectory(directory)
	dependencies.fs.writeTextFile(path.join(directory, 'summary.json'), `${JSON.stringify(report, null, '\t')}\n`)
	dependencies.fs.writeTextFile(path.join(directory, 'index.html'), renderReport(report))
	return ok(directory)
}
