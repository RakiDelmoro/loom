/**
 * The Loom UI: a run list, a live flow graph of the agents, the event feed, and
 * the diff.
 *
 * No framework and no build step — the whole thing is this file. It polls,
 * because the API is already the authority on what happened and a second channel
 * that pushes would be a second version of the truth.
 */

const POLL_MS = 1500

/** Node geometry. Shared with the CSS so the graph can be laid out before it renders. */
const NODE_W = 208
const NODE_H = 152
const GAP_X = 26
const GAP_Y = 56

const state = {
	runs: [],
	activeRunId: null,
	selected: null,
	manifest: null,
	events: [],
	diff: null,
	tab: 'graph',
	selectedAgent: null,
	error: null,
	/** What the current diff was fetched for, so a poll does not refetch it every time. */
	diffFor: null,
}

/* --- plumbing ------------------------------------------------------------ */

const el = (id) => document.getElementById(id)

function h(tag, className, content) {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (content !== undefined) node.textContent = content
	return node
}

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

function button(label, onClick, enabled = true) {
	const node = h('button', null, label)
	node.disabled = !enabled
	node.addEventListener('click', onClick)
	return node
}

/** 1234567 -> "1.2M", for token counts that would otherwise be six digits wide. */
function compact(value) {
	if (value < 1000) return String(value)
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
	return `${(value / 1_000_000).toFixed(1)}M`
}

function money(value) {
	return `$${value.toFixed(4)}`
}

function secondsBetween(startedAt, finishedAt) {
	const started = Date.parse(startedAt)
	const finished = finishedAt === null ? Date.now() : Date.parse(finishedAt)
	if (Number.isNaN(started) || Number.isNaN(finished)) return ''
	return `${((finished - started) / 1000).toFixed(1)}s`
}

/* --- the graph ----------------------------------------------------------- */

/**
 * A tidy tree: leaves take the next column, a parent centres over its children,
 * and depth is the row. Two agents sharing a role sit side by side rather than
 * overprinting, which is the whole reason for the layout rather than a list.
 */
function layoutAgents(agents) {
	const nodes = agents.map((agent) => ({ ...agent, children: [] }))
	const byId = new Map(nodes.map((node) => [node.agentId, node]))
	const roots = []

	for (const node of nodes) {
		const parent = node.parentId === null ? undefined : byId.get(node.parentId)
		if (parent === undefined) roots.push(node)
		else parent.children.push(node)
	}

	let column = 0
	let depth = 0
	const place = (node, level) => {
		node.level = level
		depth = Math.max(depth, level)
		if (node.children.length === 0) {
			node.column = column
			column += 1
			return
		}
		for (const child of node.children) place(child, level + 1)
		const first = node.children[0]
		const last = node.children[node.children.length - 1]
		node.column = (first.column + last.column) / 2
	}
	for (const root of roots) place(root, 0)

	return { nodes, columns: Math.max(column, 1), rows: depth + 1 }
}

/** How many tools each agent called, from the event stream rather than the manifest. */
function toolCounts(events) {
	const counts = new Map()
	for (const record of events) {
		if (record.type !== 'tool_call') continue
		const agentId = record.event['agentId']
		if (typeof agentId !== 'string') continue
		counts.set(agentId, (counts.get(agentId) ?? 0) + 1)
	}
	return counts
}

function renderGraph() {
	const panel = el('panel-graph')
	panel.replaceChildren()

	const agents = state.manifest?.agents ?? []
	if (agents.length === 0) {
		panel.append(h('div', 'graph-empty', state.selected === null ? 'Select a run to see its agents.' : 'No agents yet.'))
		return
	}

	// The manifest names a running agent only once it finishes, so the live one is
	// added from the log — otherwise the graph would show nothing while it worked.
	const events = state.events
	const latest = new Map()
	for (const record of events) {
		const agentId = record.event['agentId']
		if (typeof agentId !== 'string') continue
		latest.set(agentId, record.event)
	}
	const running = [...latest.entries()].filter(
		([agentId, event]) => event['type'] === 'agent_start' && !agents.some((agent) => agent.agentId === agentId),
	)

	const withLive = [
		...agents,
		...running.map(([agentId, event]) => ({
			agentId,
			role: String(event['role'] ?? 'agent'),
			parentId: typeof event['parentId'] === 'string' ? event['parentId'] : null,
			depth: Number(event['depth'] ?? 1),
			status: 'running',
			summary: 'working…',
			branch: null,
			sha: null,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			model: '',
			usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
			costUsd: 0,
		})),
	]

	const { nodes, columns, rows } = layoutAgents(withLive)
	const colW = NODE_W + GAP_X
	const rowH = NODE_H + GAP_Y
	const width = columns * colW
	const height = rows * rowH

	const graph = h('div', 'graph')
	graph.style.width = `${width}px`
	graph.style.height = `${height}px`

	// Edges first, so the nodes cover their endpoints.
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('width', String(width))
	svg.setAttribute('height', String(height))
	const byId = new Map(nodes.map((node) => [node.agentId, node]))
	for (const node of nodes) {
		const parent = node.parentId === null ? undefined : byId.get(node.parentId)
		if (parent === undefined) continue
		const x1 = parent.column * colW + NODE_W / 2
		const y1 = parent.level * rowH + NODE_H
		const x2 = node.column * colW + NODE_W / 2
		const y2 = node.level * rowH
		const bend = (y2 - y1) / 2
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`)
		path.setAttribute('class', `edge ${node.status === 'success' ? 'ok' : node.status === 'running' ? '' : 'bad'}`)
		svg.append(path)
	}
	graph.append(svg)

	const tools = toolCounts(events)
	for (const node of nodes) {
		const box = h('div', `node role-${node.role} status-${node.status}`)
		box.style.left = `${node.column * colW}px`
		box.style.top = `${node.level * rowH}px`
		box.style.width = `${NODE_W}px`
		box.style.height = `${NODE_H}px`
		if (node.agentId === state.selectedAgent) box.classList.add('selected')

		const head = h('div', 'node-role')
		head.append(h('span', 'status-dot'))
		head.append(h('span', null, node.role))
		box.append(head)

		box.append(h('div', 'node-model', node.model === '' ? node.agentId : node.model))
		box.append(h('div', 'node-summary', node.summary))

		const metrics = h('div', 'node-metrics')
		const tokens = node.usage.inputTokens + node.usage.outputTokens
		const parts = [
			['', money(node.costUsd)],
			['', `${compact(tokens)} tok`],
			['', `${String(tools.get(node.agentId) ?? 0)} tools`],
			['', secondsBetween(node.startedAt, node.finishedAt)],
		]
		for (const [, value] of parts) metrics.append(h('span', null, value))
		box.append(metrics)

		box.addEventListener('click', () => {
			state.selectedAgent = state.selectedAgent === node.agentId ? null : node.agentId
			state.diffFor = null
			void refresh()
		})
		graph.append(box)
	}

	panel.append(graph)
}

/* --- the event feed ------------------------------------------------------ */

/** One line of prose per event, with the machine fields shown as fields. */
function describeEvent(record) {
	const event = record.event
	const who = String(event['agentId'] ?? '')
	const agent = h('span', 'agent', who)
	const parts = []

	const kv = (label, value) => {
		const span = h('span', 'kv', ` ${label} `)
		parts.push(span, h('span', 'value', String(value)))
	}

	switch (record.type) {
		case 'run_started':
			parts.push(h('span', null, 'task '), h('span', 'value', String(event['task'] ?? '')))
			break
		case 'run_finished':
			kv('status', event['status'])
			parts.push(h('span', null, ' '), h('span', 'value', String(event['summary'] ?? '')))
			break
		case 'agent_start':
			parts.push(agent, h('span', 'kv', ` ${String(event['role'] ?? '')} `))
			parts.push(h('span', 'value', String(event['task'] ?? '').split('\n')[0]))
			break
		case 'agent_finish': {
			parts.push(agent, h('span', 'kv', ` ${String(event['status'] ?? '')} `))
			const summary = h('span', 'value', String(event['summary'] ?? ''))
			parts.push(summary)
			break
		}
		case 'model_call': {
			parts.push(agent, h('span', 'kv', ` ${String(event['model'] ?? '')} · ${String(event['durationMs'] ?? 0)}ms · `))
			const usage = event['usage'] ?? {}
			parts.push(h('span', 'value', `${compact(Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0))} tok`))
			break
		}
		case 'tool_call':
			parts.push(agent, h('span', 'kv', ` ${String(event['tool'] ?? '')} `))
			parts.push(h('span', 'value', String(event['arguments'] ?? '')))
			break
		case 'tool_result':
			parts.push(agent, h('span', 'kv', ` ${String(event['tool'] ?? '')} · ${String(event['kind'] ?? '')}`))
			break
		case 'commit':
			parts.push(agent, h('span', 'kv', ' commit '))
			parts.push(h('span', 'value', String(event['sha'] ?? 'nothing to commit')))
			break
		case 'integration':
			parts.push(agent, h('span', 'kv', ` integration · ${String(event['status'] ?? '')} `))
			parts.push(h('span', event['status'] === 'conflict' ? 'err' : 'value', String(event['message'] ?? '')))
			break
		case 'model_retry':
			parts.push(agent, h('span', 'kv', ` retry ${String(event['attempt'] ?? '')} in ${String(event['delayMs'] ?? '')}ms `))
			parts.push(h('span', 'err', String(event['reason'] ?? '')))
			break
		case 'operator_notice':
			parts.push(agent, h('span', 'kv', ' notice '), h('span', 'value', String(event['message'] ?? '')))
			break
		case 'alert':
			parts.push(h('span', 'kv', ` alert ${String(event['kind'] ?? '')} `))
			parts.push(h('span', 'value', `${String(event['actual'] ?? '')} / ${String(event['threshold'] ?? '')}`))
			break
		case 'error':
			parts.push(agent, h('span', 'kv', ` ${String(event['kind'] ?? '')} `))
			parts.push(h('span', 'err', String(event['message'] ?? '')))
			break
		default:
			parts.push(agent)
			break
	}

	const body = h('div', 'body')
	body.append(...parts)
	return body
}

function renderEvents() {
	const panel = el('panel-events')
	panel.replaceChildren()
	if (state.events.length === 0) {
		panel.append(h('div', 'empty', 'No events.'))
		return
	}

	const feed = h('div', 'feed')
	for (const record of state.events) {
		const row = h('div', `event k-${record.type}`)
		row.append(h('span', 'at', record.at.slice(11, 19)))
		row.append(h('span', 'kind', record.type))
		row.append(describeEvent(record))
		feed.append(row)
	}

	// Follow the stream only when the reader is already at the bottom, so scrolling
	// back to read something is not yanked away by the next poll.
	const following = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40
	panel.replaceChildren(feed)
	if (following) panel.scrollTop = panel.scrollHeight
}

/* --- the diff ------------------------------------------------------------ */

function renderDiff() {
	const panel = el('panel-diff')
	panel.replaceChildren()

	if (state.diff === null || state.diff.trim() === '') {
		panel.append(h('div', 'empty', 'No diff yet.'))
		return
	}

	const box = h('div', 'diff')
	for (const line of state.diff.split('\n')) {
		const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
			? 'meta'
			: line.startsWith('@@')
				? 'hunk'
				: line.startsWith('+')
					? 'add'
					: line.startsWith('-')
						? 'del'
						: ''
		const row = h('div', `diff-line ${cls}`)
		row.append(h('span', 'sign', line.slice(0, 1)))
		row.append(h('span', 'text', line.slice(1)))
		box.append(row)
	}
	panel.append(box)
}

/* --- the chrome ---------------------------------------------------------- */

function renderHeader() {
	const running = state.activeRunId !== null
	el('live').className = `live${running ? ' running' : ''}`
	el('live-text').textContent = running ? `running ${state.activeRunId.slice(-6)}` : 'idle'

	const stats = el('stats')
	stats.replaceChildren()
	const manifest = state.manifest
	if (manifest === null) return
	const rows = [
		['status', manifest.status],
		['agents', String(manifest.agents.length)],
		['cost', money(manifest.costUsd)],
		['tokens', compact(manifest.usage.inputTokens + manifest.usage.outputTokens)],
	]
	for (const [label, value] of rows) {
		const span = h('span')
		span.append(h('span', null, `${label} `))
		span.append(h('b', null, value))
		stats.append(span)
	}
}

function renderRunList() {
	const list = el('run-list')
	list.replaceChildren()

	for (const run of state.runs) {
		const item = h('li', `status-${run.status}${run.runId === state.selected ? ' selected' : ''}`)
		const line = h('div', 'run-line')
		line.append(h('span', 'status-dot'))
		line.append(h('span', 'run-task', run.task))
		item.append(line)

		const meta = h('div', 'run-meta')
		meta.append(h('span', null, run.status))
		meta.append(h('span', null, `${String(run.agents)} agents`))
		meta.append(h('span', null, money(run.costUsd)))
		item.append(meta)

		item.addEventListener('click', () => {
			state.selected = run.runId
			state.events = []
			state.diff = null
			state.diffFor = null
			state.selectedAgent = null
			void refresh()
		})
		list.append(item)
	}
}

function renderControls() {
	const controls = el('controls')
	controls.replaceChildren()

	const runId = state.selected
	if (runId === null) return
	const running = state.activeRunId === runId

	controls.append(
		button('pause', () => void post(`/api/runs/${runId}/pause`), running),
		button('resume', () => void post(`/api/runs/${runId}/resume`), running),
		button('undo', () => void post(`/api/runs/${runId}/undo`), true),
	)

	const steer = h('input')
	steer.placeholder = 'steer…'
	const send = button('send', () => {
		if (steer.value.trim() === '') return
		void post(`/api/runs/${runId}/steer`, { message: steer.value }).then(() => {
			steer.value = ''
		})
	}, running)
	controls.append(steer, send)
}

async function post(path, body = {}) {
	try {
		await api(path, { method: 'POST', body: JSON.stringify(body) })
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error)
	}
	await refresh()
}

function renderTabs() {
	for (const tab of el('tabs').children) tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab))
	for (const name of ['graph', 'events', 'diff']) el(`panel-${name}`).hidden = name !== state.tab
}

function render() {
	el('error').textContent = state.error ?? ''
	renderHeader()
	renderRunList()
	renderTabs()
	el('run-task').textContent = state.manifest?.task ?? (state.selected === null ? 'No run selected' : state.selected)
	renderControls()
	renderGraph()
	renderEvents()
	renderDiff()
}

/* --- polling ------------------------------------------------------------- */

async function refresh() {
	try {
		const listing = await api('/api/runs')
		state.runs = listing.runs
		state.activeRunId = listing.activeRunId
		state.error = null

		if (state.selected !== null) {
			const detail = await api(`/api/runs/${state.selected}`)
			state.manifest = detail.manifest

			const events = await api(`/api/runs/${state.selected}/events?limit=800`)
			state.events = events.events

			// The diff is a git call, so it is fetched when the thing it would show
			// has changed rather than on every poll.
			const wanted = `${state.selected}:${state.selectedAgent ?? ''}:${state.manifest.status}`
			if (state.diffFor !== wanted) {
				const agent = state.selectedAgent === null ? '' : `?agent=${encodeURIComponent(state.selectedAgent)}`
				const diff = await api(`/api/runs/${state.selected}/diff${agent}`)
				state.diff = diff.diff
				state.diffFor = wanted
			}
		}
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error)
	}
	render()
}

/* --- wiring -------------------------------------------------------------- */

el('token').value = token()
el('token').addEventListener('change', (event) => {
	localStorage.setItem('loom-token', event.target.value)
	void refresh()
})

el('tabs').addEventListener('click', (event) => {
	const tab = event.target.dataset?.tab
	if (tab === undefined) return
	state.tab = tab
	render()
})

el('submit').addEventListener('submit', async (event) => {
	event.preventDefault()
	const task = el('task-input')
	if (task.value.trim() === '') return
	try {
		const started = await api('/api/runs', { method: 'POST', body: JSON.stringify({ task: task.value }) })
		task.value = ''
		state.selected = started.runId
		state.selectedAgent = null
		state.diffFor = null
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error)
	}
	await refresh()
})

void refresh()
setInterval(() => void refresh(), POLL_MS)
