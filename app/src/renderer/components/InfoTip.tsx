import { Cloud, Info } from 'lucide-react';

/**
 * Small info bubble next to a page title. Replaces the full-width
 * "Managed in cloud" banners that pushed page content down — the same text
 * now lives in a hover popover behind a little icon (hover or keyboard-focus
 * to read it). Written for non-technical site staff: keep the text plain.
 *
 * Two flavours:
 *   - default (cloud icon) — "this data is managed in the qparking cloud"
 *   - kind="info" (i icon)  — a plain "what is this page?" explainer
 *
 * Usage, inside the page's <h1> (which needs `flex items-center gap-2`):
 *   <h1 className="... flex items-center gap-2">
 *     Season Passes <InfoTip>Season passes are created …</InfoTip>
 *   </h1>
 */
export function InfoTip({
	title = 'View only — managed in cloud',
	kind = 'cloud',
	children,
}: { title?: string; kind?: 'cloud' | 'info'; children: React.ReactNode }) {
	const Icon = kind === 'cloud' ? Cloud : Info;
	return (
		<span className="relative inline-flex group">
			<button
				type="button"
				aria-label={title}
				className="w-5 h-5 rounded-full inline-flex items-center justify-center border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 cursor-help align-middle"
			>
				<Icon size={11} />
			</button>
			<span className="hidden group-hover:block group-focus-within:block absolute left-0 top-full mt-2 z-50 w-72 sm:w-96 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 shadow-lg text-left normal-case">
				<span className="block font-bold uppercase tracking-wide text-[10px] text-blue-900">{title}</span>
				<span className="mt-1 block text-xs font-normal text-blue-900 leading-relaxed">{children}</span>
			</span>
		</span>
	);
}
