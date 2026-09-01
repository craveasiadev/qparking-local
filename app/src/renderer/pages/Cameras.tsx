import { useEffect, useState } from "react";
import { Plus, Trash2, Camera as CamIcon, X, Copy, Check, Activity, Loader2, Webhook, MapPin, KeyRound, ChevronDown, Search } from "lucide-react";
import type { DeviceHealth, LprCamera, ParkingLane } from "@shared/types";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useConfirm } from "../hooks/useConfirm";
import { usePagedList } from "../hooks/usePagination";
import { PaginationBar } from "../components/Pagination";
import { InfoTip } from "../components/InfoTip";
import { DeviceHealthBadge } from "../components/DeviceHealthBadge";
import { useDeviceHealth } from "../hooks/useDeviceHealth";
import { DeviceSyncButtons } from "../components/DeviceSyncButtons";
import { useCurrentSite } from "../context/SiteContext";

const PAGE_SIZE = 10;

/** Mirrors the `cameras.webhook_port` column default in the main process. */
const DEFAULT_WEBHOOK_PORT = 6001;

/** The port most cameras here already push to — what a new one should default to. */
function commonWebhookPort(cameras: LprCamera[]): number {
	const tally = new Map<number, number>();
	for (const camera of cameras) {
		if (camera.webhookPort > 0) tally.set(camera.webhookPort, (tally.get(camera.webhookPort) ?? 0) + 1);
	}
	let best = DEFAULT_WEBHOOK_PORT;
	let bestCount = 0;
	for (const [port, count] of tally) {
		if (count > bestCount) { best = port; bestCount = count; }
	}
	return best;
}

const EMPTY: Omit<LprCamera, "id" | "externalId" | "createdAt" | "updatedAt"> = {
	name: "",
	laneId: null,
	direction: "entry",
	accessMode: "open",
	host: "",
	deviceUser: "",
	devicePassword: "",
	devicePort: 80,
	webhookPort: DEFAULT_WEBHOOK_PORT,
	webhookSecret: "",
	// The values that were hard-coded in pulseBarrier until 2026-08-21, so a new
	// camera behaves exactly as every camera did before they became editable.
	relayChannel: 0,
	relayPulseMs: 1000,
	enabled: true,
};

export function Cameras() {
	const [cameras, setCameras] = useState<LprCamera[]>([]);
	const [lanes, setLanes] = useState<ParkingLane[]>([]);
	const [editing, setEditing] = useState<Partial<LprCamera> | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [confirm, confirmDialog] = useConfirm();
	const [diag, setDiag] = useState<{ ports: number[]; addresses: string[] } | null>(null);
	const [webhookOpen, setWebhookOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [dirFilter, setDirFilter] = useState<"all" | "entry" | "exit">("all");
	const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");

	const site = useCurrentSite();
	// Reachability is owned and pushed by the main process; this page only reads it.
	const { healthOf } = useDeviceHealth();
	const q = search.trim().toLowerCase();
	const filterActive = q !== "" || dirFilter !== "all" || statusFilter !== "all";
	const filtered = cameras.filter((c) => {
		if (dirFilter !== "all" && c.direction !== dirFilter) return false;
		if (statusFilter === "enabled" && !c.enabled) return false;
		if (statusFilter === "disabled" && c.enabled) return false;
		if (q) {
			const laneName = lanes.find((l) => l.id === c.laneId)?.name ?? "";
			const hay = `${c.name} ${c.host ?? ""} ${laneName} ${c.direction}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});
	const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
	useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q, dirFilter, statusFilter]);

	async function refresh() {
		setCameras(await window.bridge.listCameras());
		setLanes(await window.bridge.listLanes());
		setDiag((await window.bridge.diagnoseLpr()) as any);
	}
	useEffect(() => {
		void refresh();
	}, []);

	const [save, saving] = useAsyncAction(
		async () => {
			setFormError(null);
			if(!editing) return;

			const name = editing.name?.trim();
			if (!name) {
				setFormError("Name is required.");
				return;
			}

			// This app opens the barrier for every car it authorises, and that goes
			// over the camera's SDK — which needs host + username + password.
			// Saving without them would produce a lane where every decision
			// succeeds and the gate never moves. Refuse here rather than let it
			// surface at the barrier with a car sitting at it.
			const missing = [
				!editing.host?.trim() && "host / LAN IP",
				!editing.deviceUser?.trim() && "device username",
				!editing.devicePassword?.trim() && "device password",
			].filter(Boolean);
			if (missing.length > 0) {
				setFormError(
					`This app opens the barrier itself, which needs the camera's ${missing.join(", ")}. ` +
						`Fill those in — without them the plate is read and the session recorded, but the boom never moves.`,
				);
				return;
			}

			// A port outside 1–65535 cannot be bound, and 0 would bind a RANDOM
			// free port — the camera would push into nothing and every car would
			// stall at the barrier with nothing on screen to explain it.
			const webhookPort = Number(editing.webhookPort);
			if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
				setFormError("Webhook port is required and must be between 1 and 65535 (6001 unless the camera's firmware forces another).");
				return;
			}

			const isNewCamera = !editing.id;
			const savedResult = await window.bridge.saveCamera(editing as any);
			await window.bridge.insertActivityLog({ 
				eventKey: "equipment.camera.saved",
				action: isNewCamera ? "create" : "edit",
				category: "config",
				severity: "medium",
				siteId: site?.id ?? null,
				outcome: "ok",
				resourceType: "camera_device",
				resourceId: String(savedResult.id),
				description: `Camera ${(isNewCamera ? 'added' : 'updated')} · ${editing.name} · ${editing.direction}`
			});

			setEditing(null);
			await refresh();
		},
		{
			onError: (e: any) => {
				setFormError(e?.message ?? String(e));
			},
		},
	);

	const [deletingId, setDeletingId] = useState<number | null>(null);
	const [runDelete] = useAsyncAction(async (id: number) => {
		if (!(await confirm({ title: "Delete camera", message: "Delete this camera?", danger: true, confirmLabel: "Delete" }))) return;
		setDeletingId(id);
		try {
			const camera = cameras.find((camera) => camera.id === id);
			await window.bridge.deleteCamera(id);
			await window.bridge.insertActivityLog({
				eventKey: "equipment.camera.removed",
				action: "delete",
				category: "config",
				severity: "medium",
				siteId: site?.id ?? null,
				outcome: "ok",
				resourceType: "camera_device",
				resourceId: String(id),
				description: `Camera removed · ${camera?.name ?? `#${id}`}`
			});
			await refresh();
		} finally {
			setDeletingId(null);
		}
	});

	return (
		<div className="p-5 sm:p-8 max-w-7xl mx-auto">
			<header className="flex flex-wrap items-start justify-between gap-3 mb-5">
				<div>
					<h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
						LPR cameras
						<InfoTip title="About this page" kind="info">
							These are the number-plate cameras at your gates. Each camera
							reads plates and sends them to this server — set the camera to
							point at the "Webhook endpoint" address shown below. Use "Test"
							to check a camera is reachable, and assign each camera to its
							lane on the Lanes page.
						</InfoTip>
					</h1>
					<p className="text-sm text-gray-500 mt-1">Cameras POST plate detections to this server's webhook URL.</p>
					{cameras.length > 0 && (
						<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
							<span className="inline-flex items-center gap-1.5">
								<span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {cameras.filter((c) => c.enabled).length} enabled
							</span>
							<span className="inline-flex items-center gap-1.5">
								<span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {cameras.length} total
							</span>
							{filterActive && <span className="text-gray-400">· showing {filtered.length}</span>}
						</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-2">
					<div className="flex items-center gap-2">
						<DeviceSyncButtons type="cameras" onDone={refresh} />
						<button
							onClick={() => {
								setFormError(null);
								// A new camera starts on the port its siblings already use, not
								// the bare default: a site that had to move off 6001 has its
								// cameras physically configured for the other port, and an
								// operator adding the fourth camera would otherwise get a
								// silent one — pushing to a port only this row expects.
								setEditing({ ...EMPTY, webhookPort: commonWebhookPort(cameras) });
							}}
							className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide"
						>
							<Plus size={14} /> Add camera
						</button>
					</div>
				</div>
			</header>

			{diag && (
				<div className="mb-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
					<button
						onClick={() => setWebhookOpen((o) => !o)}
						aria-expanded={webhookOpen}
						className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
					>
						<span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
							<Webhook size={12} className="text-gray-400" /> Webhook endpoint
						</span>
						<span className="inline-flex items-center gap-2 text-[11px] text-gray-400">
							<span className="font-mono">
								{diag.ports.length === 1 ? `port ${diag.ports[0]}` : `ports ${diag.ports.join(", ")}`} ·{" "}
								{diag.addresses.length} address{diag.addresses.length === 1 ? "" : "es"}
							</span>
							<ChevronDown size={15} className={`transition-transform ${webhookOpen ? "rotate-180" : ""}`} />
						</span>
					</button>
					{webhookOpen && (
						<div className="px-4 pb-4 border-t border-gray-100">
							<p className="mt-3 text-sm text-gray-700">
								Each camera pushes to its own port (set in the camera's form). Point it at the address below that matches its LAN:
							</p>
							{/* Per CAMERA, not per port: the operator is holding one camera's
							    config screen and needs that camera's exact URL. Grouping by
							    port instead would make them work out which group applies. */}
							<ul className="mt-2 space-y-1 font-mono text-xs">
								{cameras.map((cam) => (
									<li key={cam.id} className="bg-gray-50 rounded-md px-3 py-2">
										<span className="font-sans text-[11px] font-semibold text-gray-500">{cam.name}</span>
										{diag.addresses.map((ip) => (
											<span key={ip} className="mt-0.5 flex items-center justify-between gap-2">
												<code>POST http://{ip}:{cam.webhookPort}/lpr/event</code>
												<CopyButton text={`http://${ip}:${cam.webhookPort}/lpr/event`} />
											</span>
										))}
										{/* The port is configured but nothing is listening on it —
										    almost always a second instance holding it (a packaged
										    build running alongside `npm run dev`). Silent otherwise:
										    the camera's push is refused by the OS and the app has
										    no read to report. */}
										{!diag.ports.includes(cam.webhookPort) && (
											<span className="mt-1 block font-sans text-[11px] font-semibold text-red-600">
												Port {cam.webhookPort} is not listening — this camera's plate pushes cannot arrive. Another copy of
												qparking-local may be holding the port.
											</span>
										)}
									</li>
								))}
								{cameras.length === 0 && <li className="text-gray-500 font-sans">No cameras yet — add one to get its push URL.</li>}
							</ul>
						</div>
					)}
				</div>
			)}

			{cameras.length > 0 && (
				<div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
					<div className="relative flex-1 sm:max-w-sm">
						<Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search name, IP, or lane…"
							className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
						/>
						{search && (
							<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
								<X size={13} />
							</button>
						)}
					</div>
					<select
						value={dirFilter}
						onChange={(e) => setDirFilter(e.target.value as any)}
						className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
					>
						<option value="all">All directions</option>
						<option value="entry">Entry</option>
						<option value="exit">Exit</option>
					</select>
					<select
						value={statusFilter}
						onChange={(e) => setStatusFilter(e.target.value as any)}
						className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
					>
						<option value="all">All status</option>
						<option value="enabled">Enabled</option>
						<option value="disabled">Disabled</option>
					</select>
					{filterActive && (
						<button
							onClick={() => {
								setSearch("");
								setDirFilter("all");
								setStatusFilter("all");
							}}
							className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap"
						>
							Clear
						</button>
					)}
				</div>
			)}

			<div className="grid grid-cols-1 gap-3">
				{pageItems.map((c) => (
					<CameraCard
						key={c.id}
						cam={c}
						health={healthOf("camera", c.id)}
						lane={lanes.find((l) => l.id === c.laneId) ?? null}
						deleting={deletingId === c.id}
						onEdit={() => {
							setFormError(null);
							setEditing(c);
						}}
						onDelete={() => runDelete(c.id)}
					/>
				))}
				{cameras.length === 0 && (
					<div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
						<CamIcon size={28} className="mx-auto text-gray-300" />
						<p className="mt-3 text-sm font-semibold text-gray-700">No cameras yet</p>
						<p className="mt-1 text-[13px] text-gray-500">Add a camera and point it at the webhook URL above to start receiving plate events.</p>
						<button
							onClick={() => {
								setFormError(null);
								// A new camera starts on the port its siblings already use, not
								// the bare default: a site that had to move off 6001 has its
								// cameras physically configured for the other port, and an
								// operator adding the fourth camera would otherwise get a
								// silent one — pushing to a port only this row expects.
								setEditing({ ...EMPTY, webhookPort: commonWebhookPort(cameras) });
							}}
							className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide"
						>
							<Plus size={13} /> Add camera
						</button>
					</div>
				)}
				{cameras.length > 0 && filtered.length === 0 && (
					<div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
						<Search size={22} className="mx-auto text-gray-300" />
						<p className="mt-2">No cameras match the current filters.</p>
						<button
							onClick={() => {
								setSearch("");
								setDirFilter("all");
								setStatusFilter("all");
							}}
							className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900"
						>
							Clear filters
						</button>
					</div>
				)}
			</div>

			<PaginationBar pager={pager} rowsOnPage={pageItems.length} />

			{editing && (
				<CameraForm
					value={editing}
					onChange={setEditing}
					onCancel={() => {
						setFormError(null);
						setEditing(null);
					}}
					onSave={save}
					saving={saving}
					error={formError}
				/>
			)}
			{confirmDialog}
		</div>
	);
}

/** One camera in the list — config at a glance (color-coded direction, host,
 *  lane, secret) plus an on-demand reachability test that shows a result banner
 *  without leaving the page. */
function CameraCard({
	cam,
	health,
	lane,
	deleting,
	onEdit,
	onDelete,
}: {
	cam: LprCamera;
	/** Live reachability from the main process. Undefined until first swept. */
	health?: DeviceHealth;
	lane: ParkingLane | null;
	deleting: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [test, setTest] = useState<{ state: "idle" | "pinging" | "ok" | "err"; text: string | null }>({ state: "idle", text: null });
	const hasHost = !!(cam.host && cam.host.trim());
	const hasCreds = hasHost && !!(cam.deviceUser?.trim() && cam.devicePassword?.trim());

	async function runTest() {
		setTest({ state: "pinging", text: "Pinging…" });
		try {
			const r = await window.bridge.pingCamera(cam.id);
			setTest(
				r.ok
					? { state: "ok", text: `Reachable · ${r.latencyMs ?? "—"}ms${r.status ? ` · status ${r.status}` : ""}` }
					: { state: "err", text: r.error ?? `status ${r.status ?? "—"}` },
			);
		} catch (e: any) {
			setTest({ state: "err", text: e?.message ?? "failed" });
		}
	}

	/**
	 * Pulse this camera's barrier relay — the exact call the live flow makes when
	 * "Barrier opened by: this app" is set. Proves the host + credentials actually
	 * work BEFORE a resident is relying on it at 2am.
	 */
	async function runBarrierTest() {
		setTest({ state: "pinging", text: "Opening barrier…" });
		try {
			const r = await window.bridge.manualOpenGate({ cameraId: cam.id, laneId: cam.laneId ?? null });
			setTest(
				r.ok
					? { state: "ok", text: r.note ?? "Barrier pulse sent" }
					: { state: "err", text: "Barrier pulse failed — check host, username and password" },
			);
		} catch (e: any) {
			setTest({ state: "err", text: e?.message ?? "failed" });
		}
	}

	return (
		<div className={`rounded-xl border bg-white overflow-hidden ${cam.enabled ? "border-gray-200" : "border-gray-200 opacity-70"}`}>
			{/* A misconfigured barrier is invisible until a car is stuck at it, so
			    the warning goes at the top of the card, not behind a Test click. */}
			{cam.risk && (
				<div className="px-4 pt-3 -mb-1">
					<p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-800">{cam.risk}</p>
				</div>
			)}
			<div className="flex flex-wrap items-start justify-between gap-3 p-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 flex-wrap">
						<CamIcon size={16} className="text-gray-400 flex-shrink-0" />
						<h3 className="font-semibold truncate">{cam.name}</h3>
						{/* Live status, pushed from the main process — no longer only
						    discoverable by clicking Test. */}
						<DeviceHealthBadge health={health} />
						<DirectionBadge direction={cam.direction} />
						{/* Entry only, for the same reason the switch is: on an exit camera
						    the stored value is inert, and a badge saying "only pass allow"
						    would claim a restriction this camera does not enforce. */}
						{cam.accessMode === "pass_only" && cam.direction !== "exit" && (
							<span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-amber-50 text-amber-700 border-amber-200">
								only pass allow
							</span>
						)}
						{cam.risk && (
							<span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-red-50 text-red-700 border-red-200">
								will not open
							</span>
						)}
						{!cam.enabled && (
							<span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-gray-100 text-gray-500 border-gray-200">
								disabled
							</span>
						)}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<Chip mono muted={!hasHost}>
							{hasHost ? cam.host : "no IP set"}
						</Chip>
						<Chip icon={MapPin} muted={!lane}>
							{lane ? lane.name : "no lane"}
						</Chip>
						{cam.webhookSecret && (
							<Chip icon={KeyRound} mono>
								{cam.webhookSecret.slice(0, 6)}…
							</Chip>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					<button
						onClick={runTest}
						disabled={!hasHost || test.state === "pinging"}
						title={hasHost ? "Ping this camera" : "Set a host / IP first"}
						className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-40"
					>
						{test.state === "pinging" ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test
					</button>
					{/* Needs SDK credentials, not just a host — the relay is driven over
					    the authenticated device connection, same as the live flow. */}
					<button
						onClick={runBarrierTest}
						disabled={!hasCreds || test.state === "pinging"}
						title={hasCreds
							? "Pulse this camera's barrier relay now"
							: "Set the host, device username and password first"}
						className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-40"
					>
						<KeyRound size={13} /> Open barrier
					</button>
					<button onClick={onEdit} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">
						Edit
					</button>
					<button
						onClick={onDelete}
						disabled={deleting}
						className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center disabled:opacity-40"
					>
						{deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
					</button>
				</div>
			</div>
			{test.text && (
				<div
					className={`px-4 py-2 text-[11px] font-mono border-t ${
						test.state === "ok"
							? "bg-emerald-50 text-emerald-800 border-emerald-100"
							: test.state === "err"
								? "bg-red-50 text-red-700 border-red-100"
								: "bg-gray-50 text-gray-600 border-gray-100"
					}`}
				>
					{test.state === "ok" ? "✓ " : test.state === "err" ? "✗ " : ""}
					{test.text}
				</div>
			)}
		</div>
	);
}

function DirectionBadge({ direction }: { direction: LprCamera["direction"] }) {
	const map: Record<LprCamera["direction"], string> = {
		entry: "bg-emerald-50 text-emerald-700 border-emerald-200",
		exit: "bg-blue-50 text-blue-700 border-blue-200",
	};
	// A legacy row could still read 'dual' if its migration failed — fall back to
	// a neutral chip rather than rendering `undefined` into the class list.
	const cls = map[direction] ?? "bg-gray-100 text-gray-500 border-gray-200";
	return (
		<span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${cls}`}>
			{direction}
		</span>
	);
}

function Chip({ children, icon: Icon, mono, muted }: { children: React.ReactNode; icon?: any; mono?: boolean; muted?: boolean }) {
	return (
		<span
			className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] ${muted ? "text-gray-400" : "text-gray-600"} ${mono ? "font-mono" : ""}`}
		>
			{Icon && <Icon size={11} className="text-gray-400 flex-shrink-0" />}
			{children}
		</span>
	);
}

function CameraForm({
	value,
	onChange,
	onCancel,
	onSave,
	saving,
	error,
}: {
	value: Partial<LprCamera>;
	onChange: (v: Partial<LprCamera>) => void;
	onCancel: () => void;
	onSave: () => void;
	saving: boolean;
	error: string | null;
}) {
	const set = (k: keyof LprCamera, v: any) => onChange({ ...value, [k]: v });
	// crypto.getRandomValues, not Math.random: this is a shared secret, and
	// Math.random is not a suitable source for one.
	const generateSecret = () => {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		set("webhookSecret", Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
	};
	const [pingResult, setPingResult] = useState<string | null>(null);

	useEffect(() => {
		const h = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", h);
		return () => window.removeEventListener("keydown", h);
	}, [onCancel]);

	const [pinging, setPinging] = useState(false);
	async function testConnection() {
		const host = (value.host ?? "").trim();
		if (!host) {
			setPingResult("Enter a camera host / LAN IP first.");
			return;
		}
		setPinging(true);
		setPingResult("Pinging…");
		// Probe the form values directly so this works before the camera is saved.
		const r = await window.bridge.pingCameraHost({ host, port: value.devicePort ?? 80 });
		// Any HTTP answer means the camera is THERE, which is what this button asks.
		// A 401 / login redirect used to read as a failure and send the installer off
		// to re-check an IP that was correct — so it now reports reachable, and says
		// the web interface wanted credentials.
		setPingResult(
			r.ok
				? (r.needsAuth
					? `✓ Reachable · its web page wants a login (status ${r.status}) · ${r.latencyMs}ms — fine for plate pushes; the SDK username/password below is what opens the barrier`
					: `✓ Reachable · status ${r.status} · ${r.latencyMs}ms`)
				: `✗ ${r.error ?? `status ${r.status}`} · ${r.latencyMs ?? "—"}ms`,
		);
		setPinging(false);
	}
	// The panel is capped to the viewport and laid out as a column: header and
	// footer stay put, only the FIELDS scroll. Without the cap the panel grew with
	// its content and pushed Save off-screen on a short window — unrecoverable,
	// since the footer is the only way to commit the form.
	return (
		<div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onCancel}>
			<div
				onClick={(e) => e.stopPropagation()}
				className="w-full max-w-xl my-auto bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
			>
				<header className="shrink-0 px-5 py-4 border-b border-gray-200 flex items-center justify-between">
					<h2 className="text-base font-bold">{value.id ? "Edit" : "Add"} camera</h2>
					<button onClick={onCancel} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500">
						<X size={18} />
					</button>
				</header>
				{/* min-h-0 is required: a flex child defaults to min-height:auto, which
				    refuses to shrink below its content and would defeat the cap above. */}
				<div className="flex-1 min-h-0 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
					<p className="sm:col-span-2 text-xs text-gray-500">
						Assign this camera to a lane from the <strong>Lanes</strong> page — a lane owns the cameras that cover it.
					</p>
					<Field label="Display name">
						<input className="input" value={value.name ?? ""} onChange={(e) => set("name", e.target.value)} />
					</Field>
					{/* One camera faces ONE way — it reads plates coming toward it. A
					    shared in/out barrier needs two cameras, one per direction;
					    the lane then shows as "dual". (The old per-camera "Dual"
					    option promised something the optics can't do: a departing
					    car only comes into frame after it has passed the barrier.) */}
					<Field label="Direction">
						<select className="input" value={value.direction ?? "entry"} onChange={(e) => set("direction", e.target.value)}>
							<option value="entry">Entry</option>
							<option value="exit">Exit</option>
						</select>
					</Field>
					{/* The whole feature, as one switch. Checking it means: every plate
					    this camera reads is looked up against the local pass roster, and
					    the barrier only rises for a plate that holds a valid pass.
					    ENTRY CAMERAS ONLY. The exit flow never reads accessMode — it asks
					    "does this vehicle hold a pass?" regardless, then prices the stay —
					    so on an exit camera this switch decides nothing. It used to be
					    shown with a note explaining that it was inert, which is worse than
					    not showing it: a control that does nothing still invites someone to
					    reason about it. The stored value is left ALONE rather than cleared,
					    so a camera flipped to exit and back keeps the setting it had; it
					    becomes visible again the moment the direction is entry. */}
					{value.direction !== "exit" && (
					<div className="sm:col-span-2">
						<label className="flex items-start gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5 cursor-pointer hover:border-gray-400">
							<input
								type="checkbox"
								className="mt-0.5"
								checked={value.accessMode === "pass_only"}
								onChange={(e) => set("accessMode", e.target.checked ? "pass_only" : "open")}
							/>
							<span>
								{/* Setup caveats live in the tip rather than a banner: they matter
								    once, when the lane is first wired up, and a permanent orange
								    block just adds noise to every later edit. */}
								<span className="text-sm font-semibold inline-flex items-center gap-1.5">
									Only Pass Allow
									<InfoTip title="Before this works" kind="info">
										The camera's own auto-open must be switched off in its web interface, or it
										will keep opening for everyone and this setting does nothing.
										<br />
										<br />
										A pass created in the cloud reaches this box on its own within 5 minutes.
										Press <strong>Sync now</strong> if a holder is already at the barrier —
										until it lands they are turned away.
									</InfoTip>
								</span>
								<span className="block text-[11px] text-gray-500 mt-0.5">
									Let a vehicle <strong>in</strong> only if it holds a <strong>valid season pass</strong>.
									With this off, every vehicle is admitted. Refused vehicles are shown ACCESS DENIED —
									staff let them through with <strong>Open barrier</strong> on the Live display.
								</span>
							</span>
						</label>
					</div>
					)}
					{/* Camera LAN IP — all that live video needs. The main process pulls
              rtsp://<host>:8557/h264 and transcodes it for the Live display. */}
					<Field label="Camera host / LAN IP">
						<input className="input font-mono" value={value.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.50" />
					</Field>
					{/* The other half of the wiring: the port THIS box listens on for
					    this camera's plate pushes — the opposite direction to "Device
					    port" below, which is a port on the camera. Per camera because
					    firmware varies in what it will let you change; leave it at 6001
					    unless the camera cannot be pointed there. The box binds a
					    listener for every port in use. */}
					<Field label="Webhook port">
						<input
							type="number"
							className="input"
							required
							min={1}
							max={65535}
							value={value.webhookPort ?? DEFAULT_WEBHOOK_PORT}
							onChange={(e) => set("webhookPort", Number(e.target.value))}
						/>
						<p className="mt-1 text-[11px] text-gray-500">
							The port this server listens on for this camera's plate pushes. 6001 unless the camera's firmware forces
							another. Its full push URL is on the Cameras page under <strong>Webhook endpoint</strong>.
						</p>
					</Field>
					{/* Device login is NOT needed for video (RTSP is token-free). It's used
              only to open the camera's onboard IO relay for "Open barrier" — leave
              blank if the barrier isn't wired to this camera. */}
					<p className="sm:col-span-2 text-xs text-gray-500 mt-1">
						<strong>Barrier relay (optional)</strong> — only if the barrier is wired to this camera's IO output. Live video doesn't need these.
					</p>
					<Field label="Device username">
						<input className="input" value={value.deviceUser ?? ""} onChange={(e) => set("deviceUser", e.target.value)} placeholder="admin" />
					</Field>
					<Field label="Device password">
						<input
							type="password"
							className="input"
							value={value.devicePassword ?? ""}
							onChange={(e) => set("devicePassword", e.target.value)}
							placeholder="camera login password"
						/>
					</Field>
					<Field label="Device port">
						<input type="number" className="input" value={value.devicePort ?? 80} onChange={(e) => set("devicePort", Number(e.target.value))} />
					</Field>
					<div className="sm:col-span-2">
						<button
							type="button"
							onClick={testConnection}
							disabled={pinging}
							className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
						>
							{pinging ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test connection
						</button>
						{pingResult && (
							<div
								className={`mt-2 rounded-md px-2 py-1.5 text-[11px] font-mono ${
									pingResult.startsWith("✓")
										? "bg-emerald-50 text-emerald-800 border border-emerald-200"
										: pingResult.startsWith("×") || pingResult.startsWith("✗")
											? "bg-red-50 text-red-700 border border-red-200"
											: "bg-gray-100 text-gray-700"
								}`}
							>
								{pingResult}
							</div>
						)}
					</div>
					{/* The barrier itself. Grouped with the SDK login rather than the
					    webhook fields because these three are what actually MOVE the boom:
					    the login opens the handle, these two say which output to pulse and
					    for how long. Both were constants with no way to change them, so a
					    boom on another IO output meant a gate that authorised every car and
					    never opened. */}
					<Field label="Barrier relay output">
						<input
							className="input"
							type="number"
							min={0}
							max={15}
							value={value.relayChannel ?? 0}
							onChange={(e) => set("relayChannel", Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
						/>
						<p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
							Which IO output on the camera the boom is wired to. <strong>0</strong> is the
							first (and on most cameras the only) relay — leave it there unless the
							installer tells you otherwise.
						</p>
					</Field>
					<Field label="Barrier pulse (ms)">
						<input
							className="input"
							type="number"
							min={500}
							max={5000}
							step={100}
							value={value.relayPulseMs ?? 1000}
							onChange={(e) => set("relayPulseMs", Number(e.target.value) || 1000)}
						/>
						<p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
							How long the relay is held closed. 1000&nbsp;ms suits most booms; raise it if
							the barrier controller needs longer to latch. The camera SDK accepts
							500&ndash;5000&nbsp;ms and anything outside that is clamped.
						</p>
					</Field>
					<Field label="Webhook secret">
						<div className="flex gap-2">
							<input className="input font-mono text-xs" value={value.webhookSecret ?? ""} onChange={(e) => set("webhookSecret", e.target.value)} />
							<button onClick={generateSecret} className="text-[11px] uppercase tracking-wide font-bold text-gray-600 px-2 hover:text-gray-900">
								Generate
							</button>
						</div>
						{/* This field had no guidance at all, and setting it on a real ANPR
						    camera silently 401s every plate read — the only symptom being one
						    throttled Activity Log row per ten minutes. Leave it EMPTY unless
						    something you control is doing the POSTing. */}
						{value.webhookSecret ? (
							<p className="mt-1.5 text-[11px] text-amber-700 leading-relaxed">
								Only set this if a script or app you control does the POSTing. ANPR camera
								firmware cannot send a custom header, so a real camera will have every
								plate read rejected (401) — with no symptom except a throttled warning
								in the Activity Log. Clear it to accept reads from the camera itself.
							</p>
						) : (
							<p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
								Leave empty for a real ANPR camera — its firmware cannot send the header.
								Set one only for a custom integration that POSTs to this box.
							</p>
						)}
					</Field>
					<Field label="Enabled">
						<label className="inline-flex items-center gap-2 mt-2 text-sm">
							<input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set("enabled", e.target.checked)} /> accept events
						</label>
					</Field>
				</div>
				{/* Outside the scroll area on purpose: a validation error must be visible
				    the moment Save is pressed, not hidden above the fold of a long form. */}
				{error && <div className="shrink-0 mx-5 mb-3 mt-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
				<footer className="shrink-0 px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
					<button onClick={onCancel} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">
						Cancel
					</button>
					<button
						onClick={onSave}
						disabled={saving}
						className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
					>
						{saving ? <Loader2 size={13} className="animate-spin" /> : null}
						{saving ? "Saving…" : "Save"}
					</button>
				</footer>
			</div>
			<style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
			{children}
		</div>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			onClick={() => {
				navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}}
			className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-gray-500 hover:text-gray-900"
		>
			{copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
		</button>
	);
}
