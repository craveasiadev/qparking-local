import { useState, useMemo, useEffect } from "react";
import { Activity, Filter, Clock, AlertCircle, AlertTriangle, Info, ChevronDown, RefreshCw, CloudDownload, X, CloudUpload } from "lucide-react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { ActivityLog } from "@shared/schema";
import { fmtDateTime } from "../lib/datetime";

const SEVERITY_COLORS: Record<ActivityLog["severity"], string> = {
	low: "bg-blue-50 border-blue-200",
	medium: "bg-amber-50 border-amber-200",
	high: "bg-orange-50 border-orange-200",
	critical: "bg-red-50 border-red-200",
};

const SEVERITY_ICONS: Record<ActivityLog["severity"], React.ReactNode> = {
	low: <Info className="w-4 h-4 text-blue-600" />,
	medium: <AlertTriangle className="w-4 h-4 text-amber-600" />,
	high: <AlertTriangle className="w-4 h-4 text-orange-600" />,
	critical: <AlertCircle className="w-4 h-4 text-red-600" />,
};

function timeAgo(isoDate: string): string {
	const date = new Date(isoDate);
	const now = new Date();
	const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

export function ActivityLogs() {
	const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState({
		category: "" as string,
		severity: "" as string,
		source: "" as string,
	});

	const [loadActivityLogs, loading] = useAsyncAction(async () => {
		setActivityLogs(await window.bridge.listActivityLogs());
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

	const filteredActivityLogs = useMemo(() => {
		return activityLogs.filter((activityLog) => {
			if (filters.category && activityLog.category !== filters.category) return false;
			if (filters.severity && activityLog.severity !== filters.severity) return false;
			if (filters.source && activityLog.source !== filters.source) return false;
			return true;
		});
	}, [activityLogs, filters]);

	const categories = Array.from(new Set(activityLogs.map((l) => l.category)));
	const severities = Array.from(new Set(activityLogs.map((l) => l.severity)));

	return (
		<div className="p-5 sm:p-8 max-w-6xl mx-auto">
			{/* Header */}
			<header className="flex flex-wrap items-start justify-between gap-3 mb-8">
				<div>
					<div className="flex items-center gap-3 mb-2">
						<Activity className="w-8 h-8 text-slate-700" />
						<h1 className="text-3xl font-bold text-slate-900">Activity Log</h1>
					</div>
					<p className="text-slate-600">Track all local server actions and events</p>
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => loadActivityLogs()}
						disabled={loading}
						className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
					>
						<RefreshCw size={13} className={loading ? "animate-spin" : ""} /> {loading ? "Refreshing…" : "Refresh"}
					</button>
					<button
						onClick={() => syncFromCloud()}
						disabled={pushing}
						className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 text-white hover:bg-gray-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50"
					>
						<CloudUpload size={13} className={pushing ? "animate-pulse" : ""} />
						{pushing ? "Pushing…" : `Push to cloud${pushToCloudActivityLogs.length ? ` (${pushToCloudActivityLogs.length})` : ""}`}
					</button>
				</div>
			</header>

			{error && (
				<div className="mb-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">
					<AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
					<p className="flex-1">{error}</p>
					<button onClick={() => setError(null)} className="flex-shrink-0 text-red-600 hover:text-red-900">
						<X className="w-4 h-4" />
					</button>
				</div>
			)}

			{/* Filters */}
			<div className="bg-white border border-slate-200 rounded-lg p-4 mb-6">
				<div className="flex items-center gap-2 mb-4">
					<Filter className="w-4 h-4 text-slate-600" />
					<h2 className="font-semibold text-slate-700">Filters</h2>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
					{/* Category Filter */}
					<div>
						<label className="block text-sm font-medium text-slate-700 mb-2">Category</label>
						<select
							value={filters.category}
							onChange={(e) => setFilters((prev) => ({ ...prev, category: e.target.value }))}
							className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
						>
							<option value="">All Categories</option>
							{categories.map((cat) => (
								<option key={cat} value={cat}>
									{cat.charAt(0).toUpperCase() + cat.slice(1)}
								</option>
							))}
						</select>
					</div>

					{/* Severity Filter */}
					<div>
						<label className="block text-sm font-medium text-slate-700 mb-2">Severity</label>
						<select
							value={filters.severity}
							onChange={(e) => setFilters((prev) => ({ ...prev, severity: e.target.value }))}
							className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
						>
							<option value="">All Levels</option>
							{severities.map((sev) => (
								<option key={sev} value={sev}>
									{sev.charAt(0).toUpperCase() + sev.slice(1)}
								</option>
							))}
						</select>
					</div>

					{/* Source Filter */}
					<div>
						<label className="block text-sm font-medium text-slate-700 mb-2">Source</label>
						<select
							value={filters.source}
							onChange={(e) => setFilters((prev) => ({ ...prev, source: e.target.value }))}
							className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
						>
							<option value="">All Sources</option>
							<option value="local">Local</option>
							<option value="cloud">Cloud</option>
						</select>
					</div>
				</div>
			</div>

			{/* Activity List */}
			<div className="space-y-3">
				{filteredActivityLogs.length === 0 ? (
					<div className="text-center py-12">
						<Info className="w-8 h-8 text-slate-400 mx-auto mb-3" />
						<p className="text-slate-600">No activities match your filters</p>
					</div>
				) : (
					filteredActivityLogs.map((log) => (
						<div
							key={log.id}
							className={`border rounded-lg transition-all cursor-pointer ${SEVERITY_COLORS[log.severity]}`}
							onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
						>
							{/* Summary Row */}
							<div className="p-4">
								<div className="flex items-start gap-4">
									{/* Icon */}
									<div className="flex-shrink-0 mt-1">{SEVERITY_ICONS[log.severity]}</div>

									{/* Main Content */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className="font-semibold text-slate-900">{log.eventKey}</span>
											<span className="inline-block px-2 py-1 text-xs font-medium rounded bg-white bg-opacity-60">{log.action}</span>
											{log.outcome && (
												<span
													className={`inline-block px-2 py-1 text-xs font-medium rounded ${
														log.outcome === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
													}`}
												>
													{log.outcome}
												</span>
											)}
										</div>
										<p className="text-slate-700 mb-2">{log.description}</p>
										<div className="flex items-center gap-4 text-xs text-slate-600">
											<div className="flex items-center gap-1">
												<Clock className="w-3 h-3" />
												{timeAgo(log.occurredAt)}
											</div>
											<div>
												<span className="inline-block px-2 py-0.5 bg-white bg-opacity-60 rounded">{log.source}</span>
											</div>
											<div>{log.actorName}</div>
										</div>
									</div>

									{/* Expand Button */}
									<div className="flex-shrink-0 mt-1">
										<ChevronDown className={`w-5 h-5 text-slate-600 transition-transform ${expandedId === log.id ? "rotate-180" : ""}`} />
									</div>
								</div>
							</div>

							{/* Expanded Details */}
							{expandedId === log.id && (
								<div className="border-t border-inherit px-4 py-3 bg-white bg-opacity-40 space-y-2">
									<div className="grid grid-cols-2 gap-4 text-sm">
										<div>
											<span className="font-medium text-slate-900">ID:</span>
											<p className="text-slate-700 font-mono text-xs truncate">{log.id}</p>
										</div>
										<div>
											<span className="font-medium text-slate-900">Timestamp:</span>
											<p className="text-slate-700">{fmtDateTime(log.occurredAt)}</p>
										</div>
										<div>
											<span className="font-medium text-slate-900">Category:</span>
											<p className="text-slate-700">{log.category.charAt(0).toUpperCase() + log.category.slice(1)}</p>
										</div>
										<div>
											<span className="font-medium text-slate-900">Severity:</span>
											<p className="text-slate-700">{log.severity.charAt(0).toUpperCase() + log.severity.slice(1)}</p>
										</div>
									</div>
								</div>
							)}
						</div>
					))
				)}
			</div>

			{/* Stats Footer */}
			<div className="mt-8 pt-6 border-t border-slate-200">
				<p className="text-sm text-slate-600">
					Showing {filteredActivityLogs.length} of {activityLogs.length} activities
				</p>
			</div>
		</div>
	);
}
