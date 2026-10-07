/**
 * The Loom UI: a run list, a run view, and the controls for the run in progress.
 *
 * No framework and no build step — the whole thing is this file. It polls, because
 * the API is already the authority on what happened and a second channel that
 * pushes would be a second version of the truth. A finished run stops polling and
 * reads once.
 */

const POLL_MS = 1500

const state = {
	runs: [],
	activeRunId: null,
	selected: null,
	manifest: null,
	events: [],
	spans: [],
	/** The event count the spans were built from, so a poll only rebuilds the trace when it moved. */
	tracedAt: -1,
	diff: null,
	error: null,
}

const el = (id) => document.getElementById(id)

function token() {
	return localStorage.getItem('loom-token') ?? ''
}

async function api(path, options = {}) {
	const headers = { 'content-type': 'application/json' }
	const bearer = token()
	if (bearer !== '') headers['authorization'] = `Bearer ${bearer}`

	const response = await fetch(path, { ...options, headers })
	const body = await response.json().catch(() => ({ error: 'the server returned no JSON' }))
	if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
	return body
}

function text(value) {
	const node = document.createElement('span')
	node.textContent = value
	return node
}

function button(label, onClick, options = {}) {
	const node = document.createElement('button')
	node.textContent = label
	if (options.disabled === true) node.disabled = true
	node.addEventListener('click', onClick)
	return node
}

function agentRow(agent) {
	const row = document.createElement('div')
	row.className = 'agent'

	const left = document.createElement('span')
	left.className = 'agent-summary'
	left.append(text(`${agent.role} · ${agent.status}`))
	if (agent.summary !== '') {
		const summary = text(` — ${agent.summary}`)
		summary.className = 'dim'
		left.append(summary)
	}
	row.append(left)

	const right = document.createElement('span')
	right.className = 'agent-actions'
	const tokens = agent.usage.inputTokens + agent.usage.outputTokens
	right.append(text(`$${agent.costUsd.toFixed(4)} · ${String(tokens)} tok · ${agent.model || 'no model'}`))
	if (agent.branch !== null) {
		right.append(
			button('diff', async () => {
				const result = await api(`/api/runs/${state.selected}/diff?agent=${encodeURIComponent(agent.agentId)}`)
				state.diff = result.diff
				render()
			}),
		)
		right.append(
			button('merge', async () => {
				await api(`/api/runs/${state.selected}/merge`, {
					method: 'POST',
					body: JSON.stringify({ agentId: agent.agentId }),
				})
				await refresh()
			}),
		)
	}
	row.append(right)
	return row
}

function render() {
	el('active').textContent = state.activeRunId === null ? 'idle' : `running ${state.activeRunId}`
	el('error').textContent = state.error ?? ''

	const list = el('run-list')
	list.replaceChildren()
	for (const run of state.runs) {
		const item = document.createElement('li')
		item.className = run.runId === state.selected ? 'selected' : ''
		item.append(text(`${run.status} · ${run.task.slice(0, 48)} · $${run.costUsd.toFixed(4)}`))
		item.addEventListener('click', () => {
			state.selected = run.runId
			state.events = []
			state.spans = []
			state.tracedAt = -1
			state.diff = null
			void refresh()
		})
		list.append(item)
	}

	if (state.selected === null) {
		el('detail-title').textContent = 'No run selected'
		el('run-meta').replaceChildren()
		el('controls').replaceChildren()
		el('agents').replaceChildren()
		el('events').textContent = ''
		el('trace').replaceChildren()
		el('diff').textContent = ''
		return
	}

	const selected = state.runs.find((run) => run.runId === state.selected)
	el('detail-title').textContent = state.selected
	el('run-meta').textContent =
		selected === undefined
			? ''
			: `${selected.status} · ${selected.agents} agent(s) · $${selected.costUsd.toFixed(4)} · base ${selected.baseSha.slice(0, 8)} · ${selected.task}`

	const controls = el('controls')
	controls.replaceChildren()
	const running = state.activeRunId === state.selected
	controls.append(
		button('pause', async () => {
			await api(`/api/runs/${state.selected}/pause`, { method: 'POST', body: '{}' })
			await refresh()
		}, { disabled: !running }),
		button('resume', async () => {
			await api(`/api/runs/${state.selected}/resume`, { method: 'POST', body: '{}' })
			await refresh()
		}, { disabled: !running }),
		button('undo', async () => {
			await api(`/api/runs/${state.selected}/undo`, { method: 'POST', body: '{}' })
			await refresh()
		}),
	)

	const steer = document.createElement('input')
	steer.placeholder = 'steer this run…'
	const send = button('send', async () => {
		if (steer.value.trim() === '') return
		await api(`/api/runs/${state.selected}/steer`, { method: 'POST', body: JSON.stringify({ message: steer.value }) })
		steer.value = ''
	}, { disabled: !running })
	controls.append(steer, send)

	el('agents').replaceChildren()
	if (state.manifest !== undefined && state.manifest !== null) {
		for (const agent of state.manifest.agents) el('agents').append(agentRow(agent))
	}

	el('events').textContent = state.events
		.map((record) => `${record.at.slice(11, 19)} ${record.type} ${summarize(record.event)}`)
		.join('\n')

	const trace = el('trace')
	trace.replaceChildren()
	const byId = new Map(state.spans.map((span) => [span.id, span]))
	for (const span of state.spans) {
		const row = document.createElement('div')
		row.className = `span span-${span.kind}`
		// Indentation is the nesting, walked from the root: a subagent's turns sit
		// under the subagent, not level with it.
		let depth = 0
		for (let parent = span.parentId; parent !== null && byId.has(parent) && depth < 8; depth += 1) {
			parent = byId.get(parent).parentId
		}
		row.style.paddingLeft = `${String(8 + depth * 18)}px`
		row.append(text(span.name))

		const right = document.createElement('span')
		right.className = 'dim'
		const latency = span.finishedAt === null ? '…' : `${String(Math.round(span.attributes.durationMs ?? 0))}ms`
		right.append(text(`${latency} · $${span.costUsd.toFixed(4)}`))
		row.append(right)
		trace.append(row)
	}
	if (state.spans.length === 0) trace.append(text('no spans yet'))

	el('diff').textContent = state.diff ?? ''
}

function summarize(event) {
	const parts = []
	for (const [key, value] of Object.entries(event)) {
		if (key === 'at' || key === 'type' || key === 'result') continue
		if (value === null || value === undefined) continue
		parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
		if (parts.length >= 4) break
	}
	return parts.join(' ')
}

async function refresh() {
	try {
		const listing = await api('/api/runs')
		state.runs = listing.runs
		state.activeRunId = listing.activeRunId
		state.error = null

		if (state.selected !== null) {
			const detail = await api(`/api/runs/${state.selected}`)
			state.manifest = detail.manifest
			const events = await api(`/api/runs/${state.selected}/events?limit=400`)
			state.events = events.events

			// A trace is derived from the log, so it is only worth rebuilding when
			// the log has grown — not on every poll of an unchanged run.
			if (events.total !== state.tracedAt) {
				const trace = await api(`/api/runs/${state.selected}/trace`)
				state.spans = trace.spans
				state.tracedAt = events.total
			}
		}
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error)
	}
	render()
}

el('token').value = token()
el('token').addEventListener('change', (event) => {
	localStorage.setItem('loom-token', event.target.value)
	void refresh()
})

el('submit').addEventListener('submit', async (event) => {
	event.preventDefault()
	const task = el('task')
	if (task.value.trim() === '') return
	try {
		const started = await api('/api/runs', { method: 'POST', body: JSON.stringify({ task: task.value }) })
		task.value = ''
		state.selected = started.runId
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error)
	}
	await refresh()
})

void refresh()
setInterval(() => {
	// The list always refreshes; a run's detail is only worth re-reading while it is going.
	void refresh()
}, POLL_MS)
