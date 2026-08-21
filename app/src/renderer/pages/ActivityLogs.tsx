import { Fragment, useState, useMemo, useEffect } from "react";
import {
	Activity, Clock, AlertCircle, AlertTriangle, Info, ChevronDown, ChevronRight,
	RefreshCw, CloudUpload, X, Search,
} from "lucide-react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useReloadOnCloudSync } from "../hooks/useReloadOnCloudSync";
import { usePagedList } from "../hooks/usePagination";
import { PaginationBar } from "../components/Pagination";
import { InfoTip } from "../components/InfoTip";
import { ActivityLog } from "@shared/schema";
import { fmtDateTime } from "../lib/datetime";

const PAGE_SIZE = 20;

const SEVERITY_BADGE: Record<ActivityLog["severity"], { cls: string; Icon: any }> = {
	low: { cls: "bg-blue-100 text-blue-800 border-blue-200", Icon: Info },
	medium: { cls: "bg-amber-100 text-amber-800 border-amber-200", Icon: AlertTriangle },
	high: { cls: "bg-orange-100 text-orange-800 border-orange-200", Icon: AlertTriangle },
	critical: { cls: "bg-red-100 text-red-800 border-red-200", Icon: AlertCircle },
};

function SeverityBadge({ severity }: { severity: ActivityLog["severity"] }) {
	const { cls, Icon } = SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.low;
	return (
		<span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wide ${cls}`}>
			<Icon size={11} /> {severity}
		</span>
	);
}

/** Verb → colour so the eye can pick out deletes/releases from routine edits
 *  without reading every row. Gate/money verbs get their own hues (entry
 *  emerald / exit sky / payment violet — the same coding the Sessions page
 *  uses for its entry/exit arrows). Unknown verbs fall back to neutral gray. */
const ENTRY_CLS = "bg-emerald-50 text-emerald-700 border-emerald-200";
const EXIT_CLS = "bg-sky-50 text-sky-700 border-sky-200";
const PAYMENT_CLS = "bg-violet-50 text-violet-700 border-violet-200";
const ACTION_BADGE: Record<string, string> = {
	entry: ENTRY_CLS,
	exit: EXIT_CLS,
	payment: PAYMENT_CLS,
	pay: PAYMENT_CLS,
	charge: PAYMENT_CLS,
	refund: PAYMENT_CLS,
	create: "bg-teal-50 text-teal-700 border-teal-200",
	edit: "bg-blue-50 text-blue-700 border-blue-200",
	update: "bg-blue-50 text-blue-700 border-blue-200",
	delete: "bg-red-50 text-red-700 border-red-200",
	access: "bg-indigo-50 text-indigo-700 border-indigo-200",
	retry: "bg-amber-50 text-amber-700 border-amber-200",
	failed: "bg-rose-50 text-rose-700 border-rose-200",
	manual_release: "bg-orange-50 text-orange-700 border-orange-200",
	manual_open: "bg-orange-50 text-orange-700 border-orange-200",
	sync: "bg-cyan-50 text-cyan-700 border-cyan-200",
};

/** Compound verbs ('vehicle_entry', 'payment_declined', 'exit_completed')
 *  still inherit the family colour via a substring check. */
function actionClass(action: string): string {
	const exact = ACTION_BADGE[action];
	if (exact) return exact;
	const a = action.toLowerCase();
	if (a.includes("entry") || a.includes("enter")) return ENTRY_CLS;
	if (a.includes("exit")) return EXIT_CLS;
	if (a.includes("pay") || a.includes("charge") || a.includes("refund")) return PAYMENT_CLS;
	return "bg-gray-50 text-gray-600 border-gray-200";
}

function ActionBadge({ action }: { action: string }) {
	return (
		<span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${actionClass(action)}`}>
			{action.replace(/_/g, " ")}
		</span>
	);
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
	if (!outcome) return <span className="text-gray-300">—</span>;
	const ok = outcome === "ok";
	return (
		<span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wide ${
			ok ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-red-100 text-red-800 border-red-200"
		}`}>
			{outcome}
		</span>
	);
}

function cap(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ActivityLogs() {
	const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [filters, setFilters] = useState({
		category: "" as string,
		severity: "" as string,
		source: "" as string,
		pushed: "" as "" | "pushed" | "unpushed",
	});
	const [totalHeld, setTotalHeld] = useState(0);

	const [loadActivityLogs, loading] = useAsyncAction(async () => {
		// Bounded read (see db.listActivityLogs). `total` is what the box actually
		// holds, so a truncated view can say so rather than passing the newest
		// slice off as the whole trail.
		const page = await window.bridge.listActivityLogs();
		setActivityLogs(page.rows);
		setTotalHeld(page.total);
	});

	const pushToCloudActivityLogs = useMemo(() => activityLogs.filter((activityLog: ActivityLog) => !activityLog.pushedToCloud), [activityLogs]);
	const [syncFromCloud, pushing] = useAsyncAction(async () => {
		const result = await window.bridge.pushActivityLogsToCloudNow();
		if (!result.ok) {
			setError(result.error ?? "Sync failed");
			return;
		}
		await loadActivityLogs();
	});

	useEffect(() => {
		loadActivityLogs();
	}, []);
	// The activity mirror is push-then-replace-all on a full pull, so after a
	// "Sync now" every row on screen is stale — including the "Not pushed yet"
	// flags, which is the column an operator watches here.
	useReloadOnCloudSync(["activity"], loadActivityLogs);

	const q = search.trim().toLowerCase();
	const filteredActivityLogs = useMemo(() => {
		return activityLogs.filter((log) => {
			if (filters.category && log.category !== filters.category) return false;
			if (filters.severity && log.severity !== filters.severity) return false;
			if (filters.source && log.source !== filters.source) return false;
			if (filters.pushed === "pushed" && !log.pushedToCloud) return false;
			if (filters.pushed === "unpushed" && log.pushedToCloud) return false;
			if (q) {
				const hay = [log.eventKey, log.action, log.description, log.actorName, log.resourceType, log.resourceId]
					.filter(Boolean).join(" ").toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
	}, [activityLogs, filters, q]);

	const { pager, pageItems } = usePagedList(filteredActivityLogs, PAGE_SIZE);
	useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q, filters.category, filters.severity, filters.source, filters.pushed]);

	// Cloud operator-CRUD rows carry no category — drop them from the filter
	// options rather than offering a blank one that matches nothing.
	const categories = Array.from(new Set(activityLogs.map((l) => l.category).filter((c): c is string => !!c)));
	const severities = Array.from(new Set(activityLogs.map((l) => l.severity)));
	// Everything is source='local' until cloud rows are mirrored down — hide the
	// source filter (and rely on the expanded details) until there's a mix.
	const hasMixedSources = new Set(activityLogs.map((l) => l.source)).size > 1;

	function toggle(id: string) {
		setExpandedId((cur) => (cur === id ? null : id));
	}

	return (
		<div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
			<header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
				<div>
					<h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
						Activity Log
						<InfoTip title="About this page" kind="info">
							A diary of everything that happens on this server — cars blocked
							at the gate, settings changed, records edited or deleted. Click a
							row to see the full detail. "Push to cloud" sends new entries to
							qparking so head office can see them too.
						</InfoTip>
					</h1>
					<p className="text-xs sm:text-sm text-gray-500 mt-1">Every local server action and event — gate opens, payments, config edits, sync runs — newest first.</p>
					{totalHeld > activityLogs.length && (
						<p className="text-[11px] text-amber-700 mt-1">
							Showing the newest {activityLogs.length.toLocaleString()} of {totalHeld.toLocaleString()} rows.
							Older entries are still on the box — search the cloud audit trail for anything further back.
						</p>
					)}
				</div>
				<div className="flex items-center gap-2 self-start sm:self-auto">
					<button
						onClick={() => syncFromCloud()}
						disabled={pushing}
						title="Deliver every not-yet-pushed row to the qparking cloud audit trail"
						className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
					>
						<CloudUpload size={13} className={pushing ? "animate-pulse" : ""} />
						{pushing ? "Pushing…" : `Push to cloud${pushToCloudActivityLogs.length ? ` (${pushToCloudActivityLogs.length})` : ""}`}
					</button>
					<button
						onClick={() => loadActivityLogs()}
						disabled={loading}
						className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50"
					>
						<RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
					</button>
				</div>
			</header>

			{error && (
				<div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">
					<AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
					<p className="flex-1">{error}</p>
					<button onClick={() => setError(null)} className="flex-shrink-0 text-red-600 hover:text-red-900">
						<X size={15} />
					</button>
				</div>
			)}

			{/* Search + category + severity + source filters */}
			<div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 mb-3">
				<div className="relative flex-1 sm:max-w-sm">
					<Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search event, description, actor…"
						className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
					/>
					{search && (
						<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
							<X size={13} />
						</button>
					)}
				</div>
				<select
					value={filters.category}
					onChange={(e) => setFilters((prev) => ({ ...prev, category: e.target.value }))}
					className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
				>
					<option value="">All categories</option>
					{categories.map((cat) => <option key={cat} value={cat}>{cap(cat)}</option>)}
				</select>
				<select
					value={filters.severity}
					onChange={(e) => setFilters((prev) => ({ ...prev, severity: e.target.value }))}
					className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
				>
					<option value="">All levels</option>
					{severities.map((sev) => <option key={sev} value={sev}>{cap(sev)}</option>)}
				</select>
				{hasMixedSources && (
					<select
						value={filters.source}
						onChange={(e) => setFilters((prev) => ({ ...prev, source: e.target.value }))}
						className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
					>
						<option value="">All sources</option>
						<option value="local">Local</option>
						<option value="cloud">Cloud</option>
					</select>
				)}
				<select
					value={filters.pushed}
					onChange={(e) => setFilters((prev) => ({ ...prev, pushed: e.target.value as "" | "pushed" | "unpushed" }))}
					title="Filter by whether the row has been delivered to the qparking cloud"
					className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
				>
					<option value="">All push status</option>
					<option value="pushed">Pushed to cloud</option>
					<option value="unpushed">Not pushed yet</option>
				</select>
			</div>

			{/* DESKTOP / TABLET TABLE */}
			<div className="hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-sm min-w-[700px]">
						<thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
							<tr>
								<th className="text-left px-3 py-2 font-bold">Event</th>
								<th className="text-left px-3 py-2 font-bold">Action</th>
								<th className="text-left px-3 py-2 font-bold">Outcome</th>
								<th className="text-left px-3 py-2 font-bold">Severity</th>
								<th className="text-left px-3 py-2 font-bold">Time</th>
								<th className="px-3 py-2"></th>
							</tr>
						</thead>
						<tbody>
							{pageItems.map((log) => {
								const isOpen = expandedId === log.id;
								return (
									<Fragment key={log.id}>
										<tr onClick={() => toggle(log.id)} className="border-t border-gray-100 cursor-pointer hover:bg-gray-50">
											<td className="px-3 py-2 max-w-[420px]">
												{/* Cloud CRUD rows have no event_key; the description below carries
												    the detail, so a dash beats an empty heading that reads as a bug. */}
												<div className="font-semibold text-xs">{log.eventKey ?? "—"}</div>
												{log.description && <div className="text-[11px] text-gray-500 truncate" title={log.description}>{log.description}</div>}
											</td>
											<td className="px-3 py-2"><ActionBadge action={log.action} /></td>
											<td className="px-3 py-2"><OutcomeBadge outcome={log.outcome} /></td>
											<td className="px-3 py-2"><SeverityBadge severity={log.severity} /></td>
											<td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
												<span className="inline-flex items-center gap-1"><Clock size={11} className="text-gray-400" /> {fmtDateTime(log.occurredAt)}</span>
											</td>
											<td className="px-3 py-2 text-right">
												{isOpen
													? <ChevronDown size={15} className="text-gray-500 inline" />
													: <ChevronRight size={15} className="text-gray-400 inline" />}
											</td>
										</tr>
										{isOpen && (
											<tr className="bg-gray-50/60 border-t border-gray-100">
												<td colSpan={6} className="px-4 py-3">
													<LogDetails log={log} />
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
							{pageItems.length === 0 && (
								<tr>
									<td colSpan={6} className="p-8 text-center text-sm text-gray-500">
										<Activity size={16} className="inline mr-1 text-gray-400" /> {q || filters.category || filters.severity || filters.source || filters.pushed ? "No activities match the current filters." : "No activity recorded yet."}
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{/* MOBILE CARDS */}
			<div className="md:hidden space-y-2">
				{pageItems.length === 0 && (
					<div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
						<Activity size={18} className="inline mr-1 text-gray-400" /> {q || filters.category || filters.severity || filters.source || filters.pushed ? "No activities match the current filters." : "No activity recorded yet."}
					</div>
				)}
				{pageItems.map((log) => {
					const isOpen = expandedId === log.id;
					return (
						<div key={log.id} onClick={() => toggle(log.id)} className="rounded-xl border border-gray-200 bg-white p-3 cursor-pointer active:bg-gray-50">
							<div className="flex items-center justify-between gap-2">
								<span className="font-semibold text-xs min-w-0 truncate">{log.eventKey ?? "—"}</span>
								<div className="flex items-center gap-1.5 flex-shrink-0">
									<SeverityBadge severity={log.severity} />
									{isOpen ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-400" />}
								</div>
							</div>
							{log.description && <p className="mt-1 text-[12px] text-gray-700">{log.description}</p>}
							<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
								<span className="inline-flex items-center gap-1"><Clock size={10} className="text-gray-400" /> {fmtDateTime(log.occurredAt)}</span>
								<ActionBadge action={log.action} />
								<OutcomeBadge outcome={log.outcome} />
							</div>
							{isOpen && (
								<div className="mt-3 pt-3 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
									<LogDetails log={log} />
								</div>
							)}
						</div>
					);
				})}
			</div>

			<PaginationBar pager={pager} rowsOnPage={pageItems.length} />
		</div>
	);
}

/** Expanded drop-down detail for one log row — everything the summary row
 *  doesn't show: identity, resource, correlation, push status, and the raw
 *  before/after diff when the writer recorded one. */
function LogDetails({ log }: { log: ActivityLog }) {
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-sm">
				<DetailItem label="ID"><span className="font-mono text-xs break-all">{log.id}</span></DetailItem>
				<DetailItem label="Occurred at">{fmtDateTime(log.occurredAt)}</DetailItem>
				<DetailItem label="Category">{log.category ? cap(log.category) : "—"}</DetailItem>
				<DetailItem label="Severity">{cap(log.severity)}</DetailItem>
				<DetailItem label="Resource">
					{log.resourceType
						? <span className="font-mono text-xs">{log.resourceType}{log.resourceId ? ` #${log.resourceId}` : ""}</span>
						: "—"}
				</DetailItem>
				<DetailItem label="Correlation">
					{log.correlationId ? <span className="font-mono text-xs break-all">{log.correlationId}</span> : "—"}
				</DetailItem>
				<DetailItem label="Actor">{log.actorName ?? "—"}</DetailItem>
				<DetailItem label="Source">{cap(log.source)}</DetailItem>
				<DetailItem label="Cloud push">
					{log.pushedToCloud
						? <span className="text-emerald-700">Pushed{log.pushedAt ? ` · ${fmtDateTime(log.pushedAt)}` : ""}</span>
						: <span className="text-amber-700">Not pushed yet{log.syncError ? ` · ${log.syncError}` : ""}</span>}
				</DetailItem>
			</div>
			{log.description && (
				<DetailItem label="Description">
					<p className="whitespace-pre-wrap">{log.description}</p>
				</DetailItem>
			)}
			{log.changes && Object.keys(log.changes).length > 0 && (
				<DetailItem label="Changes">
					<pre className="mt-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-mono overflow-x-auto">{JSON.stringify(log.changes, null, 2)}</pre>
				</DetailItem>
			)}
		</div>
	);
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-0.5">{label}</div>
			<div className="text-sm text-gray-800">{children}</div>
		</div>
	);
}
