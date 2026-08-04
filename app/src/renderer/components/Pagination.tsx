import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { Pagination } from '../hooks/usePagination';

/**
 * Footer under a server-paged table: "Showing X–Y of Z" on the left,
 * prev/next + "Page N / M" on the right. Always rendered — an empty or
 * single-page list still shows "Page 1 / 1" (buttons disabled) so the
 * footer doesn't pop in and out as filters change.
 * Pair with usePagination — pass the hook's return value straight in.
 */
export function PaginationBar({ pager, rowsOnPage }: { pager: Pagination; rowsOnPage: number }) {
	const { page, pageCount, offset, total } = pager;
	return (
		<div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
			<p className="text-[11px] text-gray-500">
				{rowsOnPage > 0 ? <>Showing {offset + 1}–{offset + rowsOnPage} of {total}</> : <>Showing 0 of {total}</>}
			</p>
			<div className="inline-flex items-center gap-1 self-start sm:self-auto">
				<button
					onClick={pager.prev}
					disabled={page === 0}
					className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 hover:border-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					<ChevronLeft size={15} />
				</button>
				<span className="text-xs font-bold tabular-nums px-3">Page {page + 1} / {pageCount}</span>
				<button
					onClick={pager.next}
					disabled={page >= pageCount - 1}
					className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 hover:border-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
				>
					<ChevronRight size={15} />
				</button>
			</div>
		</div>
	);
}

/**
 * "Loading…" pill floated over the table/cards while a page fetch is in
 * flight. Render inside the list's `relative` wrapper; combine with an
 * `opacity-60` toggle on the table itself for the dimmed effect.
 */
export function PageLoadingOverlay({ show }: { show: boolean }) {
	if (!show) return null;
	return (
		<div className="absolute inset-0 z-10 flex items-start justify-center pt-16 bg-white/50 backdrop-blur-[1px] pointer-events-none">
			<span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-500 bg-white border border-gray-200 rounded-full px-3 py-1.5 shadow-sm">
				<Loader2 size={13} className="animate-spin" /> Loading…
			</span>
		</div>
	);
}
